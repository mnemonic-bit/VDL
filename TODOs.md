# Further things to add to the download helper

* [DONE] start download when pressing enter in the form field for the URL
* [done] make the button rounded-edges; add an icon like a downward arrow which signifies that this is the download button left to the Download label of the button
* [DONE] Fav icon for the site which looks like the download symbol added to the button
* [DONE] Reload button for failed downloads
* [DONE] more verbose error message for failed downloads in a section that can be fold with an arror 
* [DONE] finished downloads should move to the next section, foldable with an arrow
* [DONE] copy URL button for finished downloads
* add tags to entries
* [DONE] make the file name editable, with pencil button at the end of the name; for this the name should be abbreviated in the display, and the pencil at the end, or the name should be displayed in a kind of text field which cannot be edited, and changes to edit-mode, as soon as the pencil-button is clicked. The pencil-button will change to a tick symbol when editing and shows also an X to its left for aborting the edit.
* search the history, filter by parts of the title, or the web site, and quality
* [DONE] show the quality of the downloaded video, during download and also in the history
* [DONE] add Escape key-binding to close the video overlay window
* [DONE] have separate lists for current downloads and finished downloads
* [DONE] add a stop-button to the list of current downloads
* [DONE] add a clear button the the section of finished downloads
* [DONE] add a configuration section for the download helper
** [DONE] dark-mode
** [DONE] save history
* Save button in Preferences: color does not match the scheme
* Save button in Preferences: Disk symbol does not appear back when the Tick vanishes after 4 seconds after saving
* Make the Tick in the menu when the URL has been copied to the clipbard appear without a green circle around it
* [DONE] Reorder the item in the Current section:
** [DONE] put the Progress bar all over the botton of the item
** [DONE] Status: downloading (percentage) and then at the right end of that same line the time remaining
** [DONE] put Total size, and Quality on the same line
* Error message missing, if the server is down and the app cannot communicate with the server any longer
* Use keep-alive to check periodically if the server is still alive, otherwise dislay a dialogue
* [DONE] The Download Options section has two triangles, the first (solid) triange should be removed.
* If no URL was entered, the Options section should be empty, with a message stating that more options will appear once an URL has been provided
* ESC-key to close the overlay video also escapes the full-screen mode on MacOS. Can this be fixed? This works better if the video has been selected with the mouse before, and if not it excapes the full-screen mode of the app instead.
* Can Ctrl-V be captured and used to insert the contens of the clipboard, if its in an URL format?
* Add Option: Audio Only


## Components to Install in Docker

* ffmpeg
* Python yt-dlp, flask
* vlc (this might be important due to codecs that ship with VLC, but its unclear at the moment if this only seemed to have helped on my MacOS)
