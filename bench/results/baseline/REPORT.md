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

