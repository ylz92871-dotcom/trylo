# Windows 2.0.0 packaging revision

The application version stays 2.0.0. The Windows installer is repacked with
the `headless-preview-zh-en-v1` Office conversion profile. The application
execution model, permissions, Code/Work UI and optional learning behavior
remain unchanged. Node, Python and the built-in tools remain bundled and offline.

The signed upstream Office distribution and shipped conversion profile have
separate pinned inventories. Fonts, filters and all 42 hyphenation registrations
are retained. Unused editing dictionaries and their XML registrations, help,
gallery, templates and extra interface languages/icon themes are omitted.
The source companion contains the exact profile and staging scripts.

Five focused profile/integrity checks passed. Chinese/English DOCX, XLSX,
PPTX, DOC, XLS and PPT samples produced identical page counts and extracted
text through the original and trimmed runtimes. This is not a full layout
acceptance suite. Resource/source supply checks and the Windows native build
passed; installed-app performance remains for manual acceptance.

The resource tree is 1,237,264,816 bytes, down from 2,161,484,237 bytes.
The solid-LZMA installer is 374,268,764 bytes, down from 623,211,161 bytes.
Its SHA256 is `468ad229c68786f347e6d123b259bcfc02090b217d7d63bfc1b0b7d178a4c75f`.
