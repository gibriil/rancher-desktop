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

/**
 * A whole-filesystem search can legitimately take longer than the ceiling
 * that's appropriate for a single directory listing.
 */
const SEARCH_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs = OPERATION_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${ description } timed out after ${ timeoutMs / 1000 }s`)),
      timeoutMs,
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

/**
 * Runs `op`, passing its result to `onResult` on success or the error
 * message to `onError` on failure -- the try/withTimeout/catch/log shape
 * every handler below needs identically (mount/list/stat/preview/search/
 * diff/mounts/download all differ only in the actual sendToFrame call and,
 * for search, a longer timeout), previously duplicated once per handler.
 *
 * Deliberately takes callbacks rather than a channel name + response args:
 * an earlier version took the channel names directly and called
 * `sendToFrame` from inside this generic helper, which meant the specific
 * argument shape each channel declares in IpcRendererEvents could no longer
 * be checked against what was actually sent -- only the channel *names*
 * were still verified, not their payloads. Each call site's own
 * `sendToFrame('channel', ...)` call below is a concrete, non-generic call,
 * so it's checked exactly as strictly as it would be with no wrapper at all.
 */
async function respond<T>(
  description: string,
  op: () => Promise<T>,
  onResult: (result: T) => void,
  onError: (message: string) => void,
  timeoutMs?: number,
): Promise<void> {
  try {
    const result = await withTimeout(op(), description, timeoutMs);

    onResult(result);
  } catch (ex) {
    console.error(`${ description } failed:`, ex);
    onError(errorMessage(ex));
  }
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

      respond(
        `Checking files support for ${ containerId }`,
        () => this.client.getContainerFilesCapabilities(containerId, { namespace }),
        result => sendToFrame('container-files/capabilities', containerId, result),
        message => sendToFrame('container-files/capabilities-error', containerId, message),
      );
    });

    ipcMainProxy.on('container-files/diff', async(event, containerId) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      await respond(
        `Getting diff for ${ containerId }`,
        () => this.client.getContainerDiff(containerId, { namespace }),
        result => sendToFrame('container-files/diff-result', containerId, result),
        message => sendToFrame('container-files/diff-error', containerId, message),
      );
    });

    ipcMainProxy.on('container-files/mounts', async(event, containerId) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      await respond(
        `Getting mounts for ${ containerId }`,
        () => this.client.getContainerMounts(containerId, { namespace }),
        result => sendToFrame('container-files/mounts-result', containerId, result),
        message => sendToFrame('container-files/mounts-error', containerId, message),
      );
    });

    ipcMainProxy.on('container-files/close', (event, containerId) => {
      this.forgetSender(containerId, event.sender);
    });

    ipcMainProxy.on('container-files/list', async(event, requestId, containerId, dirPath) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      await respond(
        `Listing ${ dirPath } in ${ containerId }`,
        () => this.client.listContainerDirectory(containerId, dirPath, { namespace }),
        result => sendToFrame('container-files/list-result', requestId, containerId, result),
        message => sendToFrame('container-files/list-error', requestId, containerId, message),
      );
    });

    ipcMainProxy.on('container-files/stat', async(event, requestId, containerId, filePath) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      await respond(
        `Stat-ing ${ filePath } in ${ containerId }`,
        () => this.client.statContainerPath(containerId, filePath, { namespace }),
        result => sendToFrame('container-files/stat-result', requestId, containerId, result),
        message => sendToFrame('container-files/stat-error', requestId, containerId, message),
      );
    });

    ipcMainProxy.on('container-files/preview', async(event, requestId, containerId, filePath) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      await respond(
        `Reading ${ filePath } in ${ containerId }`,
        () => this.client.readContainerFilePreview(containerId, filePath, { namespace }),
        result => sendToFrame('container-files/preview-result', requestId, containerId, result),
        message => sendToFrame('container-files/preview-error', requestId, containerId, message),
      );
    });

    ipcMainProxy.on('container-files/search', async(event, requestId, containerId, query) => {
      const sendToFrame = makeSendToFrame(event.sender, console);
      const namespace = this.sessions.get(containerId)?.namespace;

      await respond(
        `Searching ${ containerId } for "${ query }"`,
        () => this.client.searchContainerFiles(containerId, query, { namespace }),
        result => sendToFrame('container-files/search-result', requestId, containerId, result),
        message => sendToFrame('container-files/search-error', requestId, containerId, message),
        SEARCH_TIMEOUT_MS,
      );
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

        await respond(
          `Downloading ${ filePath } from ${ containerId }`,
          () => this.client.downloadContainerFile(containerId, filePath, destinationPath, { namespace }),
          () => sendToFrame('container-files/download-done', containerId, filePath, destinationPath),
          message => sendToFrame('container-files/download-error', containerId, filePath, message),
        );
      } catch (ex) {
        console.error(`Failed to show save dialog for ${ filePath } from ${ containerId }:`, ex);
        sendToFrame('container-files/download-error', containerId, filePath, errorMessage(ex));
      }
    });
  }
}
