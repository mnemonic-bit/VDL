# Search and filter download history

**Source section:** Further things to add to the download helper

search the history, filter by parts of the title, or the web site, and quality

## Implemented title, tag, and downloader search

- A plain text field accepts title and tag search terms plus `user:` downloader
  qualifiers, and updates the results while the user types.
- Unquoted whitespace separates terms. Double quotes group a term containing
  spaces, such as `"this is the exact title I am looking for"`. A downloader
  name containing spaces uses the same rule: `user:"Alice Smith"`.
- Each ordinary term matches either a complete tag name or a case-insensitive
  substring of the download title.
- Ordinary terms use **ANY** matching: after other qualifiers have been
  applied, a download is shown when at least one title or tag term matches.
- `user:<username>` is a mandatory, case-insensitive exact match against the
  displayed downloader name. When any `user:` qualifier is present, a download
  from an unnamed user must not appear merely because its title or tags match
  an ordinary term.
- Repeating `user:` uses **OR** matching within the downloader group. For
  example, `user:alice user:bob` shows downloads belonging to Alice or Bob.
- The downloader group and ordinary term group use **AND** matching together.
  For example, `user:alice tutorial` shows only Alice's downloads whose title
  or complete tag matches `tutorial`.
- An empty `user:` qualifier matches no downloads.
- The search lives in the header, immediately before the New download action.
  It is represented by a magnifier until selected, then expands into the input.
- Search applies only to Download History; Current downloads remain visible in
  their drawer.

Website and quality filters remain future work.
