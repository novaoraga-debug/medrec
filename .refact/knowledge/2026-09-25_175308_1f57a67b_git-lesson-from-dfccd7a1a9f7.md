---
id: a5b9747c-e79a-4c54-8f63-c8eb0ff6340c
title: Git lesson from dfccd7a1a9f7
tags:
- git
- lesson
created: 2026-09-25
updated: 2026-09-25
filenames:
- backend/src/server.js
- backend/test/google-auth.test.js
- backend/test/pharmacist-application-flow.test.js
- backend/test/registration-role-guard.test.js
links: []
kind: lesson
status: proposed
superseded_by: null
deprecated_at: null
review_after: 2026-09-25
source_chat_id: null
created_at: 2026-09-25T12:23:08.303813600+00:00
summary: null
description: null
entities: []
related_files: []
related_entities: []
content_hash: 3ab27b0d9facb204df852e7f8bd870c6665bc5a0aaedbdef850e856372563a25
source_tool: buddy_memory_lifecycle:git
source_confidence: 0.8600000143051147
source_trajectory_id: null
source_message_range: null
source_commit: dfccd7a1a9f79f70a363d4db73e9b16c7a39a4eb
topic: null
last_used_at: null
use_count: 0
last_injected_at: null
dismissed_count: 0
source_content_hash: 3ab27b0d9facb204df852e7f8bd870c6665bc5a0aaedbdef850e856372563a25
review_needed: true
occurrences: 0
---

Git lesson from dfccd7a1a9f7

Source commit: dfccd7a1a9f7
Paths: backend/src/server.js, backend/test/google-auth.test.js, backend/test/pharmacist-application-flow.test.js, backend/test/registration-role-guard.test.js
Summary: fix(security): restrict self-service auth to patients api/auth/register honoured any role, so a caller could mint an active doctor, pharmacist or admin account with no review, and api/auth/google additionally allowed pharmacist self-service. Both doors now share one policy (self-service roles = patient): doctor and pha