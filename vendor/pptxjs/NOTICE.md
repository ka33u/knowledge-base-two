# PPTXjs third-party notice

The files in this directory are vendored from
[meshesha/PPTXjs](https://github.com/meshesha/PPTXjs) at commit
`1a9260b2062f89ba822aeb54da792236780af8e7` so the intranet application does
not depend on a public CDN at runtime.

PPTXjs is distributed under the MIT License. See [LICENSE](LICENSE).

This copy includes narrow local compatibility guards for missing picture
relationships and user-facing preview failure handling. Those changes prevent a
malformed or partially supported slide from leaving the reader permanently blank.
