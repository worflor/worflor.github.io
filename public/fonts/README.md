# Fonts

Self-hosted. Nothing here is fetched from a third party at runtime, which is the
point: a webfont request carries the reader's IP address to whoever serves it,
and a font the layout measures against should not depend on a host we do not
control.

| file | family | licence |
|---|---|---|
| `InterVariable.woff2` | Inter | SIL Open Font License 1.1 |
| `ComicNeue-Regular.woff2`, `ComicNeue-Bold.woff2` | Comic Neue | SIL Open Font License 1.1 |
| `jetbrains-mono-latin.woff2`, `jetbrains-mono-latinext.woff2` | JetBrains Mono | SIL Open Font License 1.1 |
| `space-grotesk-latin.woff2`, `space-grotesk-latinext.woff2` | Space Grotesk | SIL Open Font License 1.1 |

The OFL requires the licence accompany the fonts, so it is named here for each.
Full text: <https://openfontlicense.org/>

- JetBrains Mono — <https://github.com/JetBrains/JetBrainsMono>
- Space Grotesk — <https://github.com/floriankarsten/space-grotesk>
- Inter — <https://github.com/rsms/inter>
- Comic Neue — <https://github.com/crozynski/comicneue>

## Subsetting

JetBrains Mono and Space Grotesk are variable woff2, split into `latin` and
`latinext` by `unicode-range`, which is the same split a browser used to pull
from Google for this content. A reader downloads only the subset their page
actually needs.

One consequence worth knowing rather than rediscovering: `→` (U+2192) is in
neither subset, and was in none of the subsets Google served either. It falls
back to a system face today exactly as it did before, so the Neuron pages'
`trigger → action` arrow is unchanged.
