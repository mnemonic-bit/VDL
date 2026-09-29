# Search and filter download history

**Source section:** Further things to add to the download helper

search the history, filter by parts of the title, or the web site, and quality

## Implemented title-and-tag search

- A plain text field accepts title and tag search terms and updates the results
  while the user types.
- Unquoted whitespace separates terms. Double quotes group a term containing
  spaces, such as `"this is the exact title I am looking for"`.
- Each term matches either a complete tag name or a case-insensitive substring
  of the download title.
- Terms use **ANY** matching: a download is shown when at least one term matches.
- The search lives in the header, immediately before the New download action.
  It is represented by a magnifier until selected, then expands into the input.
- Search applies only to Download History; Current downloads remain visible in
  their drawer.

Website and quality filters remain future work.
