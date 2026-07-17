import { FileWorkspaceProvider } from './archie-workspace-core.mjs';

export class SafeFileWorkspaceProvider extends FileWorkspaceProvider {
  async putArtifact(workspaceId, digest, bytes) {
    await super.putArtifact(workspaceId, digest, bytes);
    return `archie-artifact://${workspaceId}/${digest}`;
  }
}
