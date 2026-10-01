# VDL Companion privacy notice

VDL Companion captures data only when the user clicks its Firefox toolbar
action. It sends the current page URL and eligible cookies for that page and
Firefox Container to the exact HTTPS VDL origin the user paired. The extension
developer receives nothing.

The extension never stores website cookies, page URLs, request bodies,
download IDs, or browsing history. It stores the VDL origin, a narrowly scoped
bearer token, device label, extension version, and minimal connection status in
Firefox `storage.local`, which is not encrypted.

VDL keeps the website cookies in process memory only while the requested
download worker is alive. VDL persists the requested URL, including its query,
in the downloads database. Finished, failed, or cancelled work discards the
cookie stream; an interrupted authenticated download needs another explicit
toolbar click.

There is no analytics, advertising, sharing, or sale. Unpairing in Firefox or
revoking a connection in VDL Settings invalidates the companion credential.
