Have a side vision model describe what is in a picture file, answering `question`.

Use it when the model in use does not read images and a picture's path is known — an image the prompt mentioned, or one saved under the run's data folder — and what it holds matters for the task. `question` says what to look for; the answer covers only that, so ask precisely ("what error does the dialog show", "which checkbox is checked"). Use read_file on the picture instead when the model in use reads images. The description stays with the path, so a closer question can be asked again of the same picture.
