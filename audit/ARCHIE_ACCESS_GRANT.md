# Granting the next engineer GitHub access

The repository handoff can state authority, but it cannot grant a different GitHub account platform access.

For a different account, the repository owner should open the repository on GitHub, go to **Settings**, open **Collaborators and teams** (or **Collaborators**), choose **Add people**, select the engineer's exact GitHub username, and assign a role.

- **Write**: push branches and commits and work with pull requests.
- **Maintain**: everything needed for this integration, including broader repository management, without the most sensitive owner/admin powers.
- **Admin**: also permits settings, collaborator, security, and destructive repository changes. Use only when that is deliberately intended.

For this task, **Maintain** is the recommended actual repository role. The handoff grants full operational authority over code, branches, CI, issues, and the final PR, while deployment, production data, secrets, billing, and unrelated repository settings remain excluded.

An engineer using the same connected GitHub integration does not need a separate collaborator invitation; the integration's existing repository permission applies.
