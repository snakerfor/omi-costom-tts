# Admin UI Design Guidelines

## Purpose

The admin UI is not a demo page. It is a production review workspace for transcript verification, speaker identity review, and XFYUN voiceprint material management.

The core jobs are:

- Review full conversations efficiently.
- Understand speaker recognition status at the segment level.
- Add useful audio segments into a speaker's local candidate material pool.
- Curate candidate and active voiceprint materials for each official speaker.
- Update the XFYUN voiceprint feature only after explicit review.
- Inspect current data quality, recognition confidence, and update history.

The UI should be optimized for repeated operational use, not one-off debugging.

## Product Positioning

The admin platform should feel like a focused data-review product:

- Dense enough for PC-based review.
- Clear enough to audit a long transcript without visual fatigue.
- Reliable enough that user actions have obvious consequences.
- Explicit about what is local-only versus what calls XFYUN.
- Designed around the user's workflow, not around the database tables.

Primary modules:

- Conversation review workspace.
- Official speaker directory.
- Voiceprint material management.
- System tools and memory inspection.

## Global UX Principles

- Keep information compact. Avoid large vertical cards for data rows.
- Avoid duplicate controls. One function should have one clear primary entry.
- Prefer persistent toolbars for batch actions.
- Separate recognition status from voiceprint material status.
- Avoid hiding critical status inside chips mixed with body text.
- Speaker name and identity are first-class information.
- Actions that call XFYUN must be visually and semantically distinct from local-only actions.
- Default views should show complete data unless filtering is explicitly enabled.
- Do not create fake edit controls for operations that do not update the underlying data.
- When the user can make a destructive or expensive change, show budget/status before the action.

## Visual Direction

The UI should move away from the current demo-like style:

- Avoid oversized rounded cards for every row.
- Avoid excessive green backgrounds and repeated pill buttons.
- Use neutral surfaces, subtle borders, restrained status colors, and clear hierarchy.
- Use compact row layouts for transcript and speaker lists.
- Use more horizontal space on desktop.
- Use typography and spacing to make the page feel like a professional review tool.

Recommended visual traits:

- Background: neutral warm gray or off-white.
- Surfaces: white or near-white panels with thin borders.
- Radius: moderate, not oversized.
- Shadow: very subtle, only for major containers or sticky panels.
- Status colors:
  - Confirmed: green.
  - Low confidence: amber.
  - No match / neutral unresolved: gray.
  - Error: red.
  - Too short: muted gray.
- Buttons:
  - One primary action per section.
  - Secondary actions should be outline or ghost style.
  - Row actions should be compact.

## Conversation Review Workspace

### Goal

The conversation page is for reviewing transcript segments, comparing text with audio, inspecting speaker status, and adding selected segments into a speaker's candidate voiceprint material pool.

It should not be a general CRUD page.

### Layout

Recommended structure:

- Left: conversation list and filters.
- Main: selected conversation detail and transcript.
- Top of detail: conversation metadata and one embedded audio player.
- Transcript toolbar: speaker filter, short-segment filter, pagination, candidate-material batch action.
- Transcript rows: compact row layout.

Avoid:

- A separate "open full audio" link when an embedded full audio player exists.
- Large transcript cards that make a long conversation hard to scan.
- Controls squeezed into the corner without labels.

### Conversation Filters

Useful filters:

- Keyword search across transcript text.
- Speaker identity filter.
- Status filter: recording, completed, failed.
- Time range.

Less useful or removed filters:

- "Only unconfirmed speakers" as a primary filter. Unconfirmed speakers can legitimately remain long-term.
- Speaker name/Soniox label as the main search field. Keyword search across transcript content is more useful.

Page size should be placed in a proper paging area, not mixed awkwardly into the main filter area.

### Conversation List

Conversation list items should be concise:

- Start time.
- Status.
- Speaker count.
- Segment count.
- Short text preview.

Preview text should be limited. A long preview makes the list hard to use.

### Transcript Row Information

Each transcript row should show:

- Selection checkbox.
- Relative audio time, aligned with the embedded player.
- Absolute time as time-of-day only, not repeated full date.
- Speaker display name.
- Speaker identity or source label.
- Transcript text.
- Recognition status.
- Voiceprint material status, if already used.
- Compact row actions.

Do not show the full date in every row. The conversation-level date is already available at the top.

### Transcript Recognition Status

Transcript recognition status should be limited to five meaningful states:

- `已实名`: segment is bound to an official speaker.
- `低置信`: XFYUN returned a top speaker match, but the score is below the auto-confirm threshold.
- `未命中`: XFYUN did not match an existing voiceprint feature.
- `识别错误`: XFYUN call failed, audio was invalid, or another voiceprint error occurred.
- `片段过短`: segment is below the current voiceprint query/enrollment threshold.

Avoid using these as standalone transcript states:

- `待确认`.
- `未识别`.
- `未实名`.
- `人工排除`.

Those labels are either old UI wording, derived conditions, or material-management concepts. They should not be treated as primary transcript recognition states.

### Low Confidence Display

Low confidence must explain which speaker XFYUN nearly matched.

Display format:

```text
低置信 0.823 · 张三 / 本人
```

Rules:

- Show the top score.
- Show the top matched speaker name.
- Show identity when available.
- Do not use the word "候选" to describe this recognition result.
- Do not show second-choice speaker in the normal row UI.
- If no speaker is available, show only the score.

### Short Segment Filter

Add a transcript filter:

```text
[ ] 隐藏过短片段
```

Rules:

- Default is off.
- The full transcript should be visible by default because current short-segment classification may still need review.
- When enabled, rows with `片段过短` are hidden.
- The filter helps both transcript reading and material selection.
- Even when visible, too-short segments cannot be added to voiceprint materials.
- Backend validation must also reject too-short material additions.

### Transcript Material Marker

Each transcript row should show whether it is already used as voiceprint material:

```text
候选语料 · 张三
正式语料 · 张三
```

Rules:

- This marker is separate from recognition status.
- It indicates local material-pool usage, not XFYUN recognition status.
- If a row has a material marker, it cannot be added again from the transcript page.
- The transcript page must not provide a "move material" action.
- To reuse the segment for another speaker, the user must first remove it from the current speaker's material pool on the official speaker page.

### Transcript Batch Material Action

The transcript page should support batch adding selected segments into candidate materials.

The toolbar should support two target modes:

```text
目标模式:
( ) 更新已有发言人
( ) 新建发言人
```

Existing speaker mode:

```text
选择正式发言人 [select]
[加入候选语料]
```

New speaker mode:

```text
姓名 [input]
身份 [select, includes 本人]
备注 [optional]
[创建发言人并加入候选语料]
```

Rules:

- Adding candidate material is local-only.
- It must not call XFYUN.
- The user can select any segment that is not too short and not already used as material.
- This includes recognized, low-confidence, no-match, and error segments.
- If any selected segment is too short, reject or clearly skip with a count. Prefer reject so the user knows the operation did not fully apply.
- If any selected segment is already used as material, reject and explain that it must be removed from the speaker material page first.
- Creating a speaker from transcript creates a local official speaker plus candidate materials only. It does not register to XFYUN.

### Low Confidence Quick Action

Low-confidence rows may show a compact quick action:

```text
加入张三候选语料
```

Rules:

- Show only when the row has a top matched speaker.
- Show only when the segment is not already used as material.
- Show only when the segment is not too short.
- The action adds the segment to that top matched speaker's candidate materials.
- It is local-only and does not call XFYUN.
- It does not prevent the same row from being selected and added to a different speaker through batch mode, as long as it has not already been added as material.

## Official Speaker Directory

### Goal

The official speaker page is for managing speaker profiles, voiceprint materials, and recent conversations.

It is not only for editing names and identities.

### Layout

Recommended right-side detail structure:

```text
基础信息
声纹语料管理
最近会话
```

The left speaker list should be compact:

- One row per speaker.
- Name.
- Identity.
- Last seen.
- Compact edit button.

Avoid large cards for speakers. The list must scale to 10 to 20 speakers without becoming awkward.

### Speaker Basic Information

Basic information should appear near the top of the detail panel:

- Name.
- Identity.
- Notes.
- First seen.
- Last seen.
- Conversation count.
- Segment count.

Editing basic information should use a modal or clear edit surface, not an inline page mutation that shifts the detail layout.

Expected fields now:

- Name.
- Identity.
- Notes.

Allow future extension fields.

Identity options must include:

- `本人`: the device owner / data owner / person who ultimately uses the data.

### Recent Conversations

Show recent 5 conversations.

Each item should be compact:

- Conversation time.
- Status.
- Segment count.
- Link to open the conversation detail.

Do not duplicate representative segments here. Recent conversations are enough for context navigation.

## Voiceprint Material Management

### Goal

Voiceprint materials are local curated audio/text segments used to update XFYUN speaker features.

This is the most important part of long-term speaker recognition quality.

The UI should make it easy to:

- See candidate and active materials.
- Listen to material audio.
- Promote candidate to active.
- Move active back to candidate.
- Delete material.
- Watch total budget and active budget.
- Save and update XFYUN only when ready.

### Placement

Voiceprint material management belongs in the official speaker detail page, between basic information and recent conversations.

It should not be hidden inside the basic-info edit modal.

### Material Status

Use only two active statuses:

- `candidate`: local candidate material, not used for the next XFYUN update until promoted.
- `active`: official local material used when saving and updating XFYUN.

Do not use:

- `excluded`.
- Historical excluded.
- Soft delete.

Deletion means deletion from the material pool.

### Material Ownership

One transcript segment can belong to only one speaker's material pool at a time.

Database-level rule:

```text
UNIQUE(segment_id)
```

Implications:

- The same segment cannot be candidate for one speaker and active for another.
- The same segment cannot be in two candidate pools.
- To move a segment to another speaker, remove it from the current speaker's materials first, then add it again from transcript.
- Transcript should display the current material owner so the user understands why it is not selectable.

### Material Row Display

Each material row should be compact and show only necessary information:

- Text content.
- Text length.
- Audio duration.
- Listen button.
- Status: candidate or active.

Do not show by default:

- Source conversation ID.
- Absolute timestamp.
- Per-row file size.
- Complex debugging metadata.

Those may be added later behind an expand/debug control if needed, but not in the primary review UI.

### Material Budget

The material section needs a budget header.

Display:

```text
总计: 18 段 · 96.4s · 约 2.9MB / 4MB
正式: 10 段 · 61.2s · 约 1.8MB
候选: 8 段 · 35.2s · 约 1.1MB
```

Rules:

- Total = candidate + active.
- Active = active only.
- Candidate = candidate only.
- XFYUN update uses active only.
- If active exceeds 4MB, disable "save and update XFYUN".
- If active + candidate exceeds 4MB, warn that not all candidate materials can be promoted at once.
- If active + candidate is within 4MB, "promote all candidates" is safe.
- Budget should refresh after promote, demote, delete, and add operations.

Estimated size can be derived from segment duration and audio encoding when exact clip size is not available. The UI should label it as approximate if estimated.

### Material Operations

Candidate material operations:

- Promote to active.
- Delete.
- Listen.

Active material operations:

- Move back to candidate.
- Delete.
- Listen.

Batch operations:

- Promote all candidates to active.
- Save and update XFYUN.

Rules:

- Promote, demote, and delete are local database operations.
- They must not call XFYUN.
- Save and update XFYUN is the only material action that calls XFYUN.
- The UI should clearly indicate local changes are not pushed to XFYUN until saved.

### Save and Update XFYUN

Save flow:

1. Read active materials for the speaker.
2. Validate active is not empty.
3. Prepare/concatenate active audio.
4. Validate concatenated audio is below XFYUN 4MB payload limit.
5. If an active feature exists, call `updateFeature`.
6. If no feature exists, call `createFeature`.
7. Write `speaker_enrollment_batches`.
8. Keep local active materials.
9. On failure, keep local material state unchanged and show the error.

The button should communicate cost and impact:

```text
保存并更新讯飞语料库
```

This action is not just a local save.

### Enrollment Batch History

`speaker_enrollment_batches` remains useful as history:

- Show recent update batches.
- Show actual concatenated audio sent to XFYUN.
- Show duration and size.
- Show success/error status.

It should not be used as the editable material source of truth.

The editable source of truth is `speaker_voiceprint_materials`.

## Data Model Requirements

### New Material Table

Add:

```text
speaker_voiceprint_materials
- id TEXT PRIMARY KEY
- speaker_id TEXT NOT NULL
- segment_id TEXT NOT NULL UNIQUE
- conversation_id TEXT NOT NULL
- audio_path TEXT
- start_ms INTEGER NOT NULL
- end_ms INTEGER NOT NULL
- duration_ms INTEGER NOT NULL
- estimated_size_bytes INTEGER
- text TEXT
- status TEXT NOT NULL CHECK(status IN ('candidate', 'active'))
- source TEXT NOT NULL DEFAULT 'transcript'
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL
```

Indexes:

```text
speaker_id
status
conversation_id
```

### Conversation Detail Additions

Conversation detail API should return, per segment:

- Material status: candidate / active / null.
- Material speaker ID.
- Material speaker name.
- Low-confidence top matched speaker ID.
- Low-confidence top matched speaker name.
- Low-confidence top matched speaker identity.
- Low-confidence top score.

### Material API Requirements

Needed API operations:

- List materials for a speaker.
- Add selected transcript segments to existing speaker candidate materials.
- Create new speaker and add selected transcript segments to candidate materials.
- Quick-add low-confidence segment to top matched speaker candidate materials.
- Promote candidate material to active.
- Demote active material to candidate.
- Delete material.
- Promote all candidates.
- Save and update XFYUN.

All add operations must validate:

- Segment exists.
- Segment is not too short.
- Segment is not already used as material.
- Target speaker exists, unless creating a new speaker.

## Implementation Order

Recommended order:

1. Add `speaker_voiceprint_materials` schema and service functions.
2. Add material list/add/update/delete APIs.
3. Extend conversation detail with material ownership and low-confidence top speaker information.
4. Add transcript short-segment filter, default off.
5. Add transcript material markers and selection disable rules.
6. Add transcript batch-add UI for existing speaker and new speaker modes.
7. Add low-confidence quick-add action.
8. Add official speaker voiceprint material management section.
9. Add budget computation and display.
10. Add promote/demote/delete/promote-all local operations.
11. Add save-and-update-XFYUN operation.
12. Build a static UI preview before replacing the production admin layout.
13. After UI review, integrate into the real admin page.
14. Verify on real conversations containing recognized, low-confidence, no-match, error, and too-short segments.

## What Not To Do

- Do not put material transfer or material deletion on the transcript page.
- Do not allow one segment to belong to multiple speakers' material pools.
- Do not hide short segments by default.
- Do not call XFYUN when adding candidate material.
- Do not call XFYUN when promoting/demoting/deleting local materials.
- Do not display "待确认" as a primary transcript status.
- Do not show representative segments on the speaker detail page by default.
- Do not duplicate audio controls.
- Do not use large demo-style cards for long transcript or speaker lists.
- Do not bury speaker names or identities inside body text.
- Do not create UI controls that look functional but do not update the real source of truth.

## Review Checklist

Before implementing the final admin UI, verify:

- Can a user read a full transcript without excessive vertical scrolling?
- Can a user see speaker name and recognition status at a glance?
- Can a user understand low-confidence results without opening logs?
- Can a user identify which transcript segments are already used as materials?
- Can a user add selected segments to an existing speaker's candidate materials?
- Can a user create a new speaker from selected transcript segments?
- Can a user curate candidate and active materials in one place?
- Can a user see whether the 4MB limit is safe before updating XFYUN?
- Is it clear which operations are local-only and which update XFYUN?
- Can the layout scale to 10 to 20 official speakers?
- Are repeated controls removed or consolidated?
- Does the page feel like a production review tool rather than a prototype?
