Open a terminal session to a device: SSH or Telnet, like a SecureCRT console.

Usage:
- Prefer a saved `profile`: it carries the host, the user and how to sign in. See the names with terminal_sessions.
- A bare `host` (with `transport`, `port`, `user`) is for devices with no profile: a Telnet console answers its own login, so send the user name and password at its prompt. SSH sign-in comes only from a profile; passwords are the user's saved secrets, which you never see.
- The first connect to a device whose host key nobody has trusted stops and asks the user; nothing is sent until they answer.
- The result gives the new terminal's id and what the device showed first: its banner or prompt.
