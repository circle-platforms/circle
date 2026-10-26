Save a device as a profile the terminal tools can connect by: the link between
a device and how to sign in to it.

Usage:
- A profile carries the host, the port, the user and where the sign-in comes
  from: the NAME of a secret the user saved with /secrets, or a key file. The
  password value never enters the profile and you never see it.
- SSH sign-in comes only from a profile. To reach a new SSH device: ask the user
  to save its password as a secret and tell you its name, save the profile here
  naming that secret, then terminal_connect by the profile name.
- A save replaces an existing profile of the same name. The card shows the
  device, the user and the secret name, never a value.
- terminal_sessions lists what is saved. A person can also save and edit
  profiles themselves in the terminal panel or terminal-sessions.json.
