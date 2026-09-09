# Camera workspace workflow audit — 2026-09-09

This pass follows the operator's report that the refactored Camera page still
sent them to a removed rail. It covers the connected workflow, including failure
and return paths. It retains the approved instrument palette and large picture.
R-UI-29 records the current layout and behavior; it supersedes the historical
Live/Setup split, overlapping readouts and separate camera action rails.

| Contract | Result and verification |
| --- | --- |
| R-UI-28, R-UI-29: usable video lifecycle | Picture and workspace share observed Start/Stop/Starting/Retry states. An unavailable preview does not assert that the camera was stopped. Component tests cover stopped → starting → live, local Off, and failed handshakes. |
| R-SEC-13: expired browser session | A 401 stops preview retries and gates camera commands across independently bundled widgets. Sign in returns to the same local dashboard page. HTTP tests cover session checks, return paths and rejected external redirects. |
| R-CFG-03, R-UI-29: edits and completion | Draft values and highlights survive reload and sign-in without replaying actions. Apply, Keep and Revert report progress inline, block duplicate requests and preserve edits made after submission. Component tests cover confirmation and restoration before an already-expired session is handled. |
| R-CAM-05, R-VID-15, R-UI-24: connection details | An explicit authenticated read expands identity and receiver settings in the workspace, each with its own explanation and copy control. Camera selection no longer broadcasts credential-bearing stream-address messages. Details clear on camera changes and output changes. Route and component tests cover authorization, all four rendering kinds, and selection changes. |
| R-VID-19: distinct preview facts | Fixed bitrate and Adaptive with fixed size have distinct status labels. This change does not retune adaptation or claim to measure end-to-end latency. |
| R-UI-25, R-UI-29: layout and language | Removed redundant camera name/rate/state/start-check bars and the offscreen connection group. Routine messages remain inline. Browser fixture checks cover day/night, 1440 px and 390 px layouts, start, Keep, Revert and expired-session states. Narrow layout has no horizontal overflow. |

## Verification boundary

The component fixture uses production Vue components and the workspace hydration
model with simulated device replies and synthetic video. It opens no physical
camera connection. Browser interaction checks supplement component, HTTP,
flow-wiring, adapter and full workspace build checks; they do not prove USB
stability, physical gimbal motion or camera-to-screen latency.

Run the fixture through the dashboard package's gallery Vite configuration at
`camera-workflow.html`. Generate the gallery themes from the built core first.
The fixture's label explicitly identifies its simulated video and controls.

Hardware activation is coordinated with the Flight integration so both changes
ship together and the camera receives one planned restart. Deployment evidence
is recorded separately after activation; this audit alone is not a claim that a
particular device is running this revision.
