Type text to a device terminal, and Enter when `enter` is true.

Usage:
- `%NAME%` in the text puts in a variable or a saved secret: a device's password at its prompt is a secret's name, never its value, which you never see back.
- The result shows the last of the screen once it rests, or says the device is still answering: give it terminal_wait when a command runs long.
- A line carrying a word that can wipe what a device holds (reboot, erase, format, reset and the like) asks the user every time, rule aside.
