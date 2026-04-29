# Further things to add to the download helper

* [DONE] start download when pressing enter in the form field for the URL
* [done] make the button rounded-edges; add an icon like a downward arrow which signifies that this is the download button left to the Download label of the button
* Fav icon for the site which looks like the download symbol added to the button
* [DONE] Reload button for failed downloads
* [DONE] more verbose error message for failed downloads in a section that can be fold with an arror 
* [DONE] finished downloads should move to the next section, foldable with an arrow
* [DONE] copy URL button for finished downloads
* add tags to entries
* make the file name editable, with pencil button at the end of the name; for this the name should be abbreviated in the display, and the pencil at the end, or the name should be displayed in a kind of text field which cannot be edited, and changes to edit-mode, as soon as the pencil-button is clicked. The pencil-button will change to a tick symbol when editing and shows also an X to its left for aborting the edit.
* search the history, filter by parts of the title, or the web site, and quality
* show the quality of the downloaded video, during download and also in the history
* add Escape key-binding to close the video overlay window
* [DONE] have separate lists for current downloads and finished downloads
* [DONE] add a stop-button to the list of current downloads
* [DONE] add a clear button the the section of finished downloads
* [DONE] add a configuration section for the download helper
** [DONE] dark-mode
** [DONE] save history


## Components to Install in Docker

* ffmpeg
* Python yt-dlp, flask
* vlc (this might be important due to codecs that ship with VLC, but its unclear at the moment if this only seemed to have helped on my MacOS)
