# VDL

VDL accepts media URLs and keeps a persistent record of each download so the
user can manage work in progress and previously completed work.

## Language

**Download entry**:
A persisted record of one requested download throughout its lifecycle, whether
it appears under Current or Download History.
_Avoid_: Entry, item, history entry

**Tag**:
A reusable user-defined label that can be attached to download entries for
categorisation and filtering. Its identity is case-insensitive while its first
spelling is retained for display; a download entry can have zero or more tags.
_Avoid_: Category, folder
