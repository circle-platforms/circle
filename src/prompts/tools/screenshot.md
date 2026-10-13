Take a screenshot of the user's main screen, or of the front window of one application, and look at it as an image.

Usage:
- Use it to see a graphical application you are building or fixing: after you start it or change it, to check how it looks, or to see a problem the user describes.
- Pass `app` with the application's name as the system shows it (for example "Safari", "Google Chrome", "Electron", or the name of the program you started) to take only its front window. The whole screen can show the user's other, private windows, so prefer `app`.
- The user is asked before each screenshot, unless they allowed screenshots for this session.
- A large screenshot is scaled down; the result gives its size. The PNG is saved, and read_file shows it again later.
- It only looks: it cannot click or type. To use a web page, use the browser tools when you have them (the desktop application offers them), or a browser MCP server if one is configured.
