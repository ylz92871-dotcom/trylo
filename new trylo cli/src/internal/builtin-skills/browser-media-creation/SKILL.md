---
name: browser-media-creation
description: Create images or videos through a user's web AI account when no suitable generation API is configured, or when the user prefers a website. Use the built-in browser with an explicit login handoff and return the actual downloaded artifact.
---

# Browser media creation

Use this workflow for a requested image or video when direct generation tools are unavailable, or the user chooses a web service. A configured API remains a useful direct route; do not replace the user's choice.

1. Discover the current browser tool schemas and available generation tools. Do not infer availability from an earlier conversation. Check whether the request needs an image or a video and what output the user needs.
2. If the service is unknown, use the structured user-question tool to ask which web AI accounts the user already has that can create the requested medium. Offer known accounts only when the user supplied them; otherwise ask for free text. Reuse an answer already in the conversation.
3. Open the user's chosen service in the built-in browser. If login is required, hand browser control to the user and wait for confirmation that login is complete. Never request passwords, verification codes, cookies or tokens in chat, and do not inspect saved credentials.
4. After the user returns control, inspect the current page afresh. Choose the requested medium, prepare a prompt from the user's task, and use actual visible controls. Do not guess selectors, claim an API entitlement, or install an extension to bypass an unavailable feature.
5. Respect the service's displayed credits and the user's existing authorization. If generation requires an unapproved purchase, subscription or additional paid credits, ask before committing. A login answer is not a general permission grant.
6. While generation runs, keep its actual status visible and continue independent work when possible. Do not repeatedly resubmit a pending generation. Ask the user to take over again for CAPTCHA or account verification.
7. Download the actual finished image or video with the browser's supported download flow into the task's deliverables directory. Preserve the provider's format and any relevant attribution. Inspect the downloaded artifact with the existing preview tools; a screenshot of a web player is not the generated video.
8. Return the real file and a concise result. Report a failed download, an account limitation or an incomplete generation accurately, keeping the work available for continuation.

This skill supplies workflow guidance only. Tool discovery, user questions, filesystem access and browser takeover retain their existing runtime owners and permissions.
