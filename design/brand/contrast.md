# Folio contrast audit

WCAG relative luminance. Text requires 4.5:1; score ink 7:1; non-text boundaries, indicators, cursor and error-versus-ink require 3:1. Values below are unrounded for pass/fail. The saturated action has an explicit high-contrast border against surrounding surfaces. The wrong-note fill is a deliberate reviewer-approved exception to AAA score-ink contrast: as a non-text graphic it must be at least 3:1 against both the ink and paper. Its AAA-contrast ink outline, ring, × and explanatory text carry the meaning together; colour is never the sole signal. Correct-note green is also checked against ink below; it is not 3:1, so the ink-coloured ✓ is required. The Night cursor uses an opaque 4.5:1-or-higher outline; its translucent fill is a secondary cue, with notes drawn above it. The dim paper makes simultaneous 7:1 paper contrast and 3:1 ink separation unattainable with this ink/paper range.

## light

| Role | Against | Ratio | Minimum |
| --- | --- | ---: | ---: |
| text #1c2821 | bg #f5f1e8 | 13.55:1 | 4.5:1 |
| muted #4e5d52 | bg #f5f1e8 | 6.19:1 | 4.5:1 |
| success #18532d | bg #f5f1e8 | 8.05:1 | 4.5:1 |
| warning #785009 | bg #f5f1e8 | 6.32:1 | 4.5:1 |
| errorText #9f3c21 | bg #f5f1e8 | 5.93:1 | 4.5:1 |
| border #6c796d | bg #f5f1e8 | 4.06:1 | 3:1 |
| progress #286b4c | bg #f5f1e8 | 5.65:1 | 3:1 |
| focus #56447e | bg #f5f1e8 | 7.38:1 | 3:1 |
| text #1c2821 | surface #fffdf8 | 15.03:1 | 4.5:1 |
| muted #4e5d52 | surface #fffdf8 | 6.86:1 | 4.5:1 |
| success #18532d | surface #fffdf8 | 8.93:1 | 4.5:1 |
| warning #785009 | surface #fffdf8 | 7.00:1 | 4.5:1 |
| errorText #9f3c21 | surface #fffdf8 | 6.57:1 | 4.5:1 |
| border #6c796d | surface #fffdf8 | 4.50:1 | 3:1 |
| progress #286b4c | surface #fffdf8 | 6.26:1 | 3:1 |
| focus #56447e | surface #fffdf8 | 8.19:1 | 3:1 |
| text #1c2821 | raised #eee8db | 12.51:1 | 4.5:1 |
| muted #4e5d52 | raised #eee8db | 5.71:1 | 4.5:1 |
| success #18532d | raised #eee8db | 7.43:1 | 4.5:1 |
| warning #785009 | raised #eee8db | 5.83:1 | 4.5:1 |
| errorText #9f3c21 | raised #eee8db | 5.47:1 | 4.5:1 |
| border #6c796d | raised #eee8db | 3.74:1 | 3:1 |
| progress #286b4c | raised #eee8db | 5.22:1 | 3:1 |
| focus #56447e | raised #eee8db | 6.82:1 | 3:1 |
| onAction #ffffff | action #286b4c | 6.37:1 | 4.5:1 |
| mark #286b4c | bg #f5f1e8 | 5.65:1 | 3:1 |
| mark #286b4c | surface #fffdf8 | 6.26:1 | 3:1 |
| text #1c2821 | successSurface #d6eddd | 12.38:1 | 4.5:1 |
| border #6c796d | successSurface #d6eddd | 3.70:1 | 3:1 |
| onReward #0b100d | rewardFill #e9b949 | 10.51:1 | 4.5:1 |
| ink #0b100d | rewardFill #e9b949 | 10.51:1 | 4.5:1 |
| nightCursor #65b6e8 | nightPaper #1c2a23 | 6.70:1 | 4.5:1 |
| ink #0b100d | paper #fffdf8 | 18.88:1 | 7:1 |
| correct #174f2b | paper #fffdf8 | 9.43:1 | 7:1 |
| error #a83e1f | paper #fffdf8 | 6.12:1 | 3:1 |
| error #a83e1f | ink #0b100d | 3.08:1 | 3:1 |
| cursor #357db0 | paper #fffdf8 | 4.38:1 | 3:1 |
| cursor #357db0 | ink #0b100d | 4.31:1 | 3:1 |
| nightInk #f5ebd8 | nightPaper #1c2a23 | 12.64:1 | 7:1 |
| cursor #357db0 | nightPaper #1c2a23 | 3.35:1 | 3:1 |
| cursor #357db0 | nightInk #f5ebd8 | 3.77:1 | 3:1 |
| nightError #c36e48 | nightPaper #1c2a23 | 4.02:1 | 3:1 |
| nightError #c36e48 | nightInk #f5ebd8 | 3.15:1 | 3:1 |
| correct #174f2b | ink #0b100d | 2.00:1 | informational · ✓ required |
| nightCorrect #9dd5b0 | nightInk #f5ebd8 | 1.41:1 | informational · ✓ required |

## dark

| Role | Against | Ratio | Minimum |
| --- | --- | ---: | ---: |
| text #f7f2e8 | bg #14211a | 14.91:1 | 4.5:1 |
| muted #d4decf | bg #14211a | 12.00:1 | 4.5:1 |
| success #a8dbb2 | bg #14211a | 10.65:1 | 4.5:1 |
| warning #f2cf8b | bg #14211a | 11.15:1 | 4.5:1 |
| errorText #ffb9aa | bg #14211a | 10.12:1 | 4.5:1 |
| border #98ab9a | bg #14211a | 6.83:1 | 3:1 |
| progress #9dd5b0 | bg #14211a | 9.97:1 | 3:1 |
| focus #d5c7f4 | bg #14211a | 10.54:1 | 3:1 |
| text #f7f2e8 | surface #203027 | 12.44:1 | 4.5:1 |
| muted #d4decf | surface #203027 | 10.01:1 | 4.5:1 |
| success #a8dbb2 | surface #203027 | 8.88:1 | 4.5:1 |
| warning #f2cf8b | surface #203027 | 9.30:1 | 4.5:1 |
| errorText #ffb9aa | surface #203027 | 8.44:1 | 4.5:1 |
| border #98ab9a | surface #203027 | 5.70:1 | 3:1 |
| progress #9dd5b0 | surface #203027 | 8.31:1 | 3:1 |
| focus #d5c7f4 | surface #203027 | 8.79:1 | 3:1 |
| text #f7f2e8 | raised #304338 | 9.48:1 | 4.5:1 |
| muted #d4decf | raised #304338 | 7.63:1 | 4.5:1 |
| success #a8dbb2 | raised #304338 | 6.77:1 | 4.5:1 |
| warning #f2cf8b | raised #304338 | 7.09:1 | 4.5:1 |
| errorText #ffb9aa | raised #304338 | 6.43:1 | 4.5:1 |
| border #98ab9a | raised #304338 | 4.34:1 | 3:1 |
| progress #9dd5b0 | raised #304338 | 6.33:1 | 3:1 |
| focus #d5c7f4 | raised #304338 | 6.70:1 | 3:1 |
| onAction #ffffff | action #286b4c | 6.37:1 | 4.5:1 |
| mark #9dd5b0 | bg #14211a | 9.97:1 | 3:1 |
| mark #9dd5b0 | surface #203027 | 8.31:1 | 3:1 |
| text #f7f2e8 | successSurface #304b39 | 8.59:1 | 4.5:1 |
| border #98ab9a | successSurface #304b39 | 3.94:1 | 3:1 |
| onReward #0b100d | rewardFill #efc15d | 11.38:1 | 4.5:1 |
| ink #0b100d | rewardFill #efc15d | 11.38:1 | 4.5:1 |
| nightCursor #65b6e8 | nightPaper #1c2a23 | 6.70:1 | 4.5:1 |
| ink #0b100d | paper #e9dfcd | 14.53:1 | 7:1 |
| correct #174f2b | paper #e9dfcd | 7.26:1 | 7:1 |
| error #a83e1f | paper #e9dfcd | 4.71:1 | 3:1 |
| error #a83e1f | ink #0b100d | 3.08:1 | 3:1 |
| cursor #357db0 | paper #e9dfcd | 3.37:1 | 3:1 |
| cursor #357db0 | ink #0b100d | 4.31:1 | 3:1 |
| nightInk #f5ebd8 | nightPaper #1c2a23 | 12.64:1 | 7:1 |
| cursor #357db0 | nightPaper #1c2a23 | 3.35:1 | 3:1 |
| cursor #357db0 | nightInk #f5ebd8 | 3.77:1 | 3:1 |
| nightError #c36e48 | nightPaper #1c2a23 | 4.02:1 | 3:1 |
| nightError #c36e48 | nightInk #f5ebd8 | 3.15:1 | 3:1 |
| correct #174f2b | ink #0b100d | 2.00:1 | informational · ✓ required |
| nightCorrect #9dd5b0 | nightInk #f5ebd8 | 1.41:1 | informational · ✓ required |
