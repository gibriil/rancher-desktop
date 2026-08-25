import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ContainerInspect.vue', () => {
  it('gives the mount destination button a role- class so it is exempt from the dev-only roleless-button outline warning', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'pkg/rancher-desktop/components/ContainerInspect.vue'),
      'utf8',
    );
    const buttonMatch = source.match(/<button\s+class="([^"]*mount-destination-link[^"]*)"/);

    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch![1].split(/\s+/)).toEqual(expect.arrayContaining(['mount-destination-link', 'role-link']));
  });
});
