# Search and filter download history

**Source section:** Further things to add to the download helper

search the history, filter by parts of the title, or the web site, and quality

## Implemented title-and-tag search

- The existing tag picker also accepts free-form title search terms.
- Unquoted whitespace separates terms. Double quotes group a term containing
  spaces, such as `"this is the exact title I am looking for"`.
- Each term matches either a complete tag name or a case-insensitive substring
  of the download title.
- **ALL** requires every term to match, while **ANY** requires at least one.
- Search applies only to Download History; Current downloads remain visible in
  their drawer.

Website and quality filters remain future work.
