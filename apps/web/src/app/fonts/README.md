# Fonts

Self-hosted, complete official fonts. Both are licensed under the SIL Open Font License 1.1
(see the licence files next to them).

| File                                          | Font                             | Version | Source                                                                                                          |
| --------------------------------------------- | -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `InterVariable.woff2`                         | Inter Variable (opsz, wght)      | 4.001   | [rsms/inter](https://github.com/rsms/inter) release v4.1, `web/InterVariable.woff2`                             |
| `SourceHanSansCN-{Regular,Medium,Bold}.woff2` | 思源黑体 CN / Source Han Sans CN | 2.005   | [adobe-fonts/source-han-sans](https://github.com/adobe-fonts/source-han-sans) `release` branch, `SubsetOTF/CN/` |

The Source Han Sans files are the official OTFs repackaged as WOFF2 with
`fontTools.ttLib.woff2.compress`: every table is byte-identical to the OTF after
decompression, except the `head` checksum adjustment and the WOFF2 "converted" flag;
`DSIG` is dropped as WOFF2 requires. Nothing is subsetted, so the Reserved Font
Name "Source" still applies unchanged. Do not replace these files with subsets.
