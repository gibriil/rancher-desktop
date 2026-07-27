/**
 * This module handles browsing a container's filesystem for the Files tab.
 * Every operation is backed by ContainerEngineClient.listContainerDirectory/
 * statContainerPath/readContainerFilePreview/downloadContainerFile, which
 * mount the container's rootfs inside the VM and read it with the VM's own
 * coreutils -- never by exec-ing into the container -- so this works even on
 * `scratch` images with no shell of their own.
 *
 * Unlike ContainerStatsHandler/ContainerExecHandler, there is no persistent
 * session state to keep alive between calls: mounting a *live* container's
 * rootfs (as opposed to an image, which needs a throwaway container created
 * first) is a cheap, no-data-copy operation, so each request mounts,
 * performs its one operation, and unmounts again on its own. This handler
 * only tracks which renderer frames currently have a container's Files tab
 * open, so it can (a) remember the namespace picked at open time, and
 * (b) broadcast 'container-files/stopped' if the engine is switched out
 * from under an open tab.
 */

import path from 'path';

import Electron from 'electron';

import type { ContainerEngineClient } from '@pkg/backend/containerClient';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import { makeSendToFrame } from '@pkg/window';

const console = Logging.containerFiles;
const ipcMainProxy = getIpcMainProxy(console);

/**
 * Ceiling for a single mount+operate(+unmount) round trip.  None of the
 * underlying VM operations support cancellation (VMExecutor has no abort
 * mechanism), so a timeout here doesn't kill whatever's actually stuck --
 * it just stops the renderer from waiting on it forever.  A stuck operation
 * this races against may still finish in the background, unobserved; that's
 * an acceptable trade-off against leaving the UI in an infinite spinner with
 * no error at all.
 */
const OPERATION_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${ description } timed out after ${ OPERATION_TIMEOUT_MS / 1000 }s`)),
      OPERATION_TIMEOUT_MS,
    );

    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (ex) => { clearTimeout(timer); reject(ex) },
    );
  });
}

interface FilesSession {
  namespace: string | undefined;
  senders:   Set<Electron.WebContents>;
}

function errorMessage(ex: unknown): string {
  return ex instanceof Error ? ex.message : String(ex);
}

export class ContainerFilesHandler {
  protected sessions = new Map<string, FilesSession>(); // containerId -> session

  constructor(protected client: ContainerEngineClient) {
    this.initHandlers();
  }

  updateClient(client: ContainerEngineClient) {
    this.client = client;
    this.stopAll();
  }

  stopAll() {
    for (const [containerId, session] of this.sessions) {
      for (const sender of session.senders) {
        try {
          sender.send('container-files/stopped', containerId);
        } catch {}
      }
    }
    this.sessions.clear();
  }

  /** Remove `sender` from a container's session, dropping the session once no frame is watching it. */
  protected forgetSender(containerId: string, sender: Electron.WebContents) {
    const session = this.sessions.get(containerId);

    if (!session) return;
    session.senders.delete(sender);
    if (session.senders.size === 0) {
      this.sessions.delete(containerId);
    }
  }

  protected initHandlers() {
    ipcMainProxy.on('container-files/open', (event, containerId, namespace) => {
      let session = this.sessions.get(containerId);

      if (!session) {
        session = { namespace, senders: new Set() };
        this.sessions.set(containerId, session);
      }
      session.senders.add(event.sender);
      event.sender.once('destroyed', () => this.forgetSender(containerId, event.sender));

      const sendToFrame = makeSendToFrame(event.sender, console);

      withTimeout(this.client.getContainerFilesCapabilities(containerId, { namespace }), `Checking files support for ${ containerId }`)
        .then(result => sendToFrame('container-files/capabilities', containerId, result))
        .catch((ex) => {
          console.debug(`Failed to get files capabilities for ${ containerId }:`, ex);
        });
    });

    ipcMainProxy.on('container-files/diff', async(event, containerId) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      try {
        const entries = await withTimeout(this.client.getContainerDiff(containerId, { namespace }), `Getting diff for ${ containerId }`);

        sendToFrame('container-files/diff-result', containerId, entries);
      } catch (ex) {
        console.error(`Failed to get diff for ${ containerId }:`, ex);
        sendToFrame('container-files/diff-error', containerId, errorMessage(ex));
      }
    });

    ipcMainProxy.on('container-files/mounts', async(event, containerId) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      try {
        const mounts = await withTimeout(this.client.getContainerMounts(containerId, { namespace }), `Getting mounts for ${ containerId }`);

        sendToFrame('container-files/mounts-result', containerId, mounts);
      } catch (ex) {
        console.error(`Failed to get mounts for ${ containerId }:`, ex);
        sendToFrame('container-files/mounts-error', containerId, errorMessage(ex));
      }
    });

    ipcMainProxy.on('container-files/close', (event, containerId) => {
      this.forgetSender(containerId, event.sender);
    });

    ipcMainProxy.on('container-files/list', async(event, requestId, containerId, dirPath) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      try {
        const result = await withTimeout(this.client.listContainerDirectory(containerId, dirPath, { namespace }), `Listing ${ dirPath } in ${ containerId }`);

        sendToFrame('container-files/list-result', requestId, containerId, result);
      } catch (ex) {
        console.error(`Failed to list ${ dirPath } in ${ containerId }:`, ex);
        sendToFrame('container-files/list-error', requestId, containerId, errorMessage(ex));
      }
    });

    ipcMainProxy.on('container-files/stat', async(event, requestId, containerId, filePath) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      try {
        const result = await withTimeout(this.client.statContainerPath(containerId, filePath, { namespace }), `Stat-ing ${ filePath } in ${ containerId }`);

        sendToFrame('container-files/stat-result', requestId, containerId, result);
      } catch (ex) {
        console.error(`Failed to stat ${ filePath } in ${ containerId }:`, ex);
        sendToFrame('container-files/stat-error', requestId, containerId, errorMessage(ex));
      }
    });

    ipcMainProxy.on('container-files/preview', async(event, requestId, containerId, filePath) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      try {
        const result = await withTimeout(this.client.readContainerFilePreview(containerId, filePath, { namespace }), `Reading ${ filePath } in ${ containerId }`);

        sendToFrame('container-files/preview-result', requestId, containerId, result);
      } catch (ex) {
        console.error(`Failed to read ${ filePath } in ${ containerId }:`, ex);
        sendToFrame('container-files/preview-error', requestId, containerId, errorMessage(ex));
      }
    });

    ipcMainProxy.on('container-files/download', async(event, containerId, filePath) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;
      const window = Electron.BrowserWindow.fromWebContents(event.sender);

      try {
        const dialogOptions = { defaultPath: path.basename(filePath) };
        const { canceled, filePath: destinationPath } = window
          ? await Electron.dialog.showSaveDialog(window, dialogOptions)
          : await Electron.dialog.showSaveDialog(dialogOptions);

        if (canceled || !destinationPath) {
          sendToFrame('container-files/download-cancelled', containerId, filePath);

          return;
        }

        await withTimeout(
          this.client.downloadContainerFile(containerId, filePath, destinationPath, { namespace }),
          `Downloading ${ filePath } from ${ containerId }`,
        );
        sendToFrame('container-files/download-done', containerId, filePath, destinationPath);
      } catch (ex) {
        console.error(`Failed to download ${ filePath } from ${ containerId }:`, ex);
        sendToFrame('container-files/download-error', containerId, filePath, errorMessage(ex));
      }
    });
  }
}
