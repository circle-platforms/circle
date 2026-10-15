# Paths (Circle)

Workspace is the trusted project directory Circle was started in.

- Prefer a workspace-relative path (`src/file.py`).
- A leading slash is a real host path (`/home/…`, `/tmp/…`, `~/…`, a Windows drive or UNC path). It is not joined onto the workspace.
- Read or list a host path when the user asks. Prefer editing inside the workspace unless they want another tree.
- Use the built-in file and shell tools.
