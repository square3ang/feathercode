# feathercode bench report

## baseline

### baseline — features `observe` · model sonnet · 2.1.293 (Claude Code)

| task | pass | req (sub) | input | output | cache read | cache write | hit % | breaks | first prompt | sys chars | tools listed (chars) | turns | sec | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kleur-bright#1 | ✅ | 3 (0) | 6 | 1,404 | 46,624 | 10,515 | 81.6 | 0 | 16,262 | 6,240 | 11 (14,899) | 3 | 11.5 | 0.065 |
| mit-count-runs#1 | ✅ | 5 (0) | 10 | 1,631 | 80,108 | 8,419 | 90.5 | 0 | 16,337 | 6,242 | 11 (14,899) | 5 | 33.7 | 0.066 |
| tomli-explain#1 | ✅ | 4 (0) | 8 | 625 | 61,234 | 7,395 | 89.2 | 0 | 16,223 | 6,241 | 11 (14,899) | 4 | 9.0 | 0.048 |
| tomli-tabfix#1 | ✅ | 4 (0) | 8 | 507 | 61,377 | 7,618 | 88.9 | 0 | 16,196 | 6,240 | 11 (14,899) | 4 | 9.8 | 0.048 |
| **total** | 4/4 | 16 | 32 | 4,167 | 249,343 | 33,947 | 88.0 | 0 | | | | | 64 | 0.227 |

#### cache breaks (all tasks)

| cause (candidate) | breaks | tokens re-written |
|---|---|---|
| (no cache breaks) | 0 | 0 |

<details><summary>break details</summary>

| loop | turn/step | lost | gap s | causes |
|---|---|---|---|---|

</details>

#### attachments (all tasks)

| attachment | count | chars |
|---|---|---|
| skill_listing | 4 | 26,744 |
| agent_listing_delta | 4 | 6,544 |
| environment | 4 | 2,807 |
| session_context | 4 | 2,298 |
| remote_session_change | 4 | 2,180 |
| deferred_tools_delta | 4 | 1,636 |
| total_tokens_reminder | 16 | 784 |
| model | 4 | 512 |
| date | 4 | 108 |

## s1-prompt

### s1-prompt — features `prompt` · model sonnet · 2.1.293 (Claude Code)

| task | pass | req (sub) | input | output | cache read | cache write | hit % | breaks | first prompt | sys chars | tools listed (chars) | turns | sec | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kleur-bright#1 | ✅ | 3 (0) | 6 | 1,097 | 32,444 | 18,600 | 63.6 | 0 | 14,915 | 2,316 | 11 (14,899) | 3 | 10.7 | 0.092 |
| mit-count-runs#1 | ✅ | 4 (0) | 8 | 1,564 | 58,334 | 6,743 | 89.6 | 0 | 14,985 | 2,316 | 11 (14,899) | 4 | 67.6 | 0.054 |
| tomli-explain#1 | ✅ | 4 (0) | 8 | 679 | 57,950 | 6,375 | 90.1 | 0 | 14,878 | 2,316 | 11 (14,899) | 4 | 9.4 | 0.044 |
| tomli-tabfix#1 | ✅ | 4 (0) | 8 | 519 | 57,793 | 5,769 | 90.9 | 0 | 14,850 | 2,316 | 11 (14,899) | 4 | 9.9 | 0.040 |
| **total** | 4/4 | 15 | 30 | 3,859 | 206,521 | 37,487 | 84.6 | 0 | | | | | 98 | 0.230 |

#### cache breaks (all tasks)

| cause (candidate) | breaks | tokens re-written |
|---|---|---|
| (no cache breaks) | 0 | 0 |

<details><summary>break details</summary>

| loop | turn/step | lost | gap s | causes |
|---|---|---|---|---|

</details>

#### attachments (all tasks)

| attachment | count | chars |
|---|---|---|
| skill_listing | 4 | 26,744 |
| agent_listing_delta | 4 | 6,544 |
| environment | 4 | 2,807 |
| session_context | 4 | 2,298 |
| remote_session_change | 4 | 2,180 |
| deferred_tools_delta | 4 | 1,636 |
| total_tokens_reminder | 15 | 735 |
| model | 4 | 512 |
| date | 4 | 108 |

## s2-cache

### s2-cache — features `prompt,cache` · model sonnet · 2.1.293 (Claude Code)

| task | pass | req (sub) | input | output | cache read | cache write | hit % | breaks | first prompt | sys chars | tools listed (chars) | turns | sec | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kleur-bright#1 | ✅ | 5 (0) | 10 | 1,569 | 74,644 | 6,746 | 91.7 | 0 | 13,420 | 2,316 | 11 (14,899) | 5 | 14.9 | 0.058 |
| mit-count-runs#1 | ✅ | 5 (0) | 10 | 2,323 | 69,256 | 5,886 | 92.2 | 0 | 13,470 | 2,316 | 11 (14,899) | 5 | 22.4 | 0.061 |
| tomli-explain#1 | ✅ | 4 (0) | 8 | 674 | 53,499 | 5,026 | 91.4 | 0 | 13,366 | 2,316 | 11 (14,899) | 4 | 8.9 | 0.038 |
| tomli-tabfix#1 | ✅ | 4 (0) | 8 | 562 | 53,234 | 4,477 | 92.2 | 0 | 13,331 | 2,316 | 11 (14,899) | 4 | 8.9 | 0.034 |
| **total** | 4/4 | 18 | 36 | 5,128 | 250,633 | 22,135 | 91.9 | 0 | | | | | 55 | 0.190 |

#### cache breaks (all tasks)

| cause (candidate) | breaks | tokens re-written |
|---|---|---|
| (no cache breaks) | 0 | 0 |

<details><summary>break details</summary>

| loop | turn/step | lost | gap s | causes |
|---|---|---|---|---|

</details>

#### attachments (all tasks)

| attachment | count | chars |
|---|---|---|
| skill_listing | 4 | 11,436 |
| agent_listing_delta | 4 | 6,544 |
| environment | 4 | 2,807 |
| remote_session_change | 4 | 2,180 |
| deferred_tools_delta | 4 | 1,636 |
| model | 4 | 512 |
| date | 4 | 108 |
| total_tokens_reminder | 18 | 0 |
| session_context | 4 | 0 |

## s3-tools

### s3-tools — features `prompt,cache,tools` · model sonnet · 2.1.293 (Claude Code)

| task | pass | req (sub) | input | output | cache read | cache write | hit % | breaks | first prompt | sys chars | tools listed (chars) | turns | sec | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kleur-bright#1 | ✅ | 3 (0) | 6 | 1,383 | 23,083 | 7,207 | 76.2 | 0 | 7,355 | 2,316 | 7 (3,775) | 3 | 11.8 | 0.047 |
| mit-count-runs#1 | ✅ | 4 (0) | 8 | 1,575 | 30,897 | 6,083 | 83.5 | 0 | 7,407 | 2,316 | 7 (3,775) | 4 | 56.1 | 0.046 |
| tomli-explain#1 | ✅ | 4 (0) | 8 | 798 | 30,153 | 5,499 | 84.6 | 0 | 7,304 | 2,316 | 7 (3,775) | 5 | 9.7 | 0.036 |
| tomli-tabfix#1 | ✅ | 4 (0) | 8 | 529 | 28,825 | 4,163 | 87.4 | 0 | 7,267 | 2,316 | 7 (3,775) | 4 | 9.7 | 0.028 |
| **total** | 4/4 | 15 | 30 | 4,285 | 112,958 | 22,952 | 83.1 | 0 | | | | | 87 | 0.157 |

#### cache breaks (all tasks)

| cause (candidate) | breaks | tokens re-written |
|---|---|---|
| (no cache breaks) | 0 | 0 |

<details><summary>break details</summary>

| loop | turn/step | lost | gap s | causes |
|---|---|---|---|---|

</details>

#### attachments (all tasks)

| attachment | count | chars |
|---|---|---|
| skill_listing | 4 | 11,436 |
| agent_listing_delta | 4 | 6,544 |
| deferred_tools_delta | 8 | 3,364 |
| environment | 4 | 2,807 |
| remote_session_change | 4 | 2,180 |
| model | 4 | 512 |
| date | 4 | 108 |
| total_tokens_reminder | 15 | 0 |
| session_context | 4 | 0 |

## s4-modes

### s4-modes — features `prompt,cache,tools,modes,agents` · model sonnet · 2.1.293 (Claude Code)

| task | pass | req (sub) | input | output | cache read | cache write | hit % | breaks | first prompt | sys chars | tools listed (chars) | turns | sec | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kleur-bright#1 | ✅ | 4 (0) | 8 | 1,311 | 32,572 | 6,682 | 83.0 | 0 | 7,167 | 2,316 | 7 (3,775) | 4 | 12.4 | 0.046 |
| mit-count-runs#1 | ✅ | 4 (0) | 8 | 1,487 | 29,710 | 5,515 | 84.3 | 0 | 7,217 | 2,316 | 7 (3,775) | 4 | 78.2 | 0.043 |
| tomli-explain#1 | ✅ | 4 (0) | 8 | 580 | 28,503 | 4,455 | 86.5 | 0 | 7,114 | 2,316 | 7 (3,775) | 4 | 18.8 | 0.029 |
| tomli-tabfix#1 | ✅ | 5 (0) | 10 | 654 | 37,176 | 4,336 | 89.5 | 0 | 7,079 | 2,316 | 7 (3,775) | 5 | 10.0 | 0.031 |
| **total** | 4/4 | 17 | 34 | 4,032 | 127,961 | 20,988 | 85.9 | 0 | | | | | 119 | 0.150 |

#### cache breaks (all tasks)

| cause (candidate) | breaks | tokens re-written |
|---|---|---|
| (no cache breaks) | 0 | 0 |

<details><summary>break details</summary>

| loop | turn/step | lost | gap s | causes |
|---|---|---|---|---|

</details>

#### attachments (all tasks)

| attachment | count | chars |
|---|---|---|
| skill_listing | 4 | 11,436 |
| agent_listing_delta | 4 | 4,284 |
| deferred_tools_delta | 8 | 3,364 |
| environment | 4 | 2,807 |
| remote_session_change | 4 | 2,180 |
| model | 4 | 512 |
| date | 4 | 108 |
| total_tokens_reminder | 17 | 0 |
| session_context | 4 | 0 |

## s5-all

### s5-all — features `all` · model sonnet · 2.1.293 (Claude Code)

| task | pass | req (sub) | input | output | cache read | cache write | hit % | breaks | first prompt | sys chars | tools listed (chars) | turns | sec | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kleur-bright#1 | ✅ | 3 (0) | 6 | 1,385 | 22,496 | 6,788 | 76.8 | 0 | 7,166 | 2,316 | 7 (3,775) | 3 | 14.6 | 0.046 |
| mit-count-runs#1 | ✅ | 5 (0) | 10 | 1,726 | 40,425 | 5,958 | 87.1 | 0 | 7,219 | 2,316 | 7 (3,775) | 5 | 53.4 | 0.049 |
| tomli-explain#1 | ✅ | 4 (0) | 8 | 620 | 28,375 | 4,307 | 86.8 | 0 | 7,114 | 2,316 | 7 (3,775) | 4 | 13.1 | 0.029 |
| tomli-tabfix#1 | ✅ | 4 (0) | 8 | 517 | 28,719 | 4,435 | 86.6 | 0 | 7,078 | 2,316 | 7 (3,775) | 4 | 11.7 | 0.029 |
| **total** | 4/4 | 16 | 32 | 4,248 | 120,015 | 21,488 | 84.8 | 0 | | | | | 93 | 0.152 |

#### cache breaks (all tasks)

| cause (candidate) | breaks | tokens re-written |
|---|---|---|
| (no cache breaks) | 0 | 0 |

<details><summary>break details</summary>

| loop | turn/step | lost | gap s | causes |
|---|---|---|---|---|

</details>

#### attachments (all tasks)

| attachment | count | chars |
|---|---|---|
| skill_listing | 4 | 11,436 |
| agent_listing_delta | 4 | 4,284 |
| deferred_tools_delta | 8 | 3,364 |
| environment | 4 | 2,807 |
| remote_session_change | 4 | 2,180 |
| model | 4 | 512 |
| date | 4 | 108 |
| total_tokens_reminder | 16 | 0 |
| session_context | 4 | 0 |

## comparison (vs first)

weighted = input + 2×cache write (1h TTL) + 0.1×cache read + 5×output: API-price-equivalent input tokens, a proxy for plan usage.

| label | pass | requests | first prompt (avg) | input | output | cache read | cache write | hit % | breaks | weighted | Δ weighted | Δ cache write | Δ cache read | sec |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 4/4 | 16 | 16,254 | 32 | 4,167 | 249,343 | 33,947 | 88.0 | 0 | 113,695 | +0.0% | +0.0% | +0.0% | 64 |
| s1-prompt | 4/4 | 15 | 14,907 | 30 | 3,859 | 206,521 | 37,487 | 84.6 | 0 | 114,951 | +1.1% | +10.4% | -17.2% | 98 |
| s2-cache | 4/4 | 18 | 13,396 | 36 | 5,128 | 250,633 | 22,135 | 91.9 | 0 | 95,009 | -16.4% | -34.8% | +0.5% | 55 |
| s3-tools | 4/4 | 15 | 7,333 | 30 | 4,285 | 112,958 | 22,952 | 83.1 | 0 | 78,654 | -30.8% | -32.4% | -54.7% | 87 |
| s4-modes | 4/4 | 17 | 7,144 | 34 | 4,032 | 127,961 | 20,988 | 85.9 | 0 | 74,966 | -34.1% | -38.2% | -48.7% | 119 |
| s5-all | 4/4 | 16 | 7,144 | 32 | 4,248 | 120,015 | 21,488 | 84.8 | 0 | 76,249 | -32.9% | -36.7% | -51.9% | 93 |
