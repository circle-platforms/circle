Give a page files from this computer, for a file input or for the file chooser one of your clicks opened.

Usage:
- With `ref`, the files go to that file input; the snapshot shows it as `file`, with what it accepts and the files chosen. Many pages hide the input behind a button: click the button, and the result shows a file chooser waiting; then call this without `ref`.
- `paths` are the files, as the file tools take them (relative to the workspace, or full). An input that is not `multiple` takes one. An empty list closes the waiting chooser without a file.
- The user is asked every time, with the files and the site they would go to. Files the browser downloaded are in the folder its download events name.
- The result is the page's new snapshot. With `ref`, it names the input as the snapshot shows it, and says when that is not what `element` described. Submitting the form is a separate click.
