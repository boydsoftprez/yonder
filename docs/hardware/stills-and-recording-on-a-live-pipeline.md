# Taking a still, and recording, without disturbing what is already running

Measured on a Raspberry Pi 4 on 2026-09-07, before Task 33 was built, because
the task's own wording turns on it: *a frame from the running pipeline **without
restarting the source or interrupting a recording***. That is a claim about
GStreamer's dynamic pads, and it is cheaper to find out first than to discover
it in a review.

Both spikes ran against a pipeline of the same shape as the board's — a source,
a `raw` tee, an encode, a `main` tee — with a probe on a branch that must not
stop, counting any gap in its buffer timestamps. That probe is the same evidence
`yonder-pipeline`'s own `broke_over` already uses for a retune.

## A still, off the raw tee

**It works, repeatably, and nothing else notices.** Three stills in a row, each
a real 1280×720 JPEG, with **no gap over 100 ms** on the branch that kept
running.

The recipe:

1. `tee.get_request_pad("src_%u")`, link it to `queue ! videoconvert ! jpegenc
   ! filesink`, and `sync_state_with_parent()` each new element.
2. A buffer probe on the queue's src pad lets the **first** buffer through and
   drops the rest.
3. Wait for that probe to fire a **second** time. That is what proves the first
   buffer is clear of the encoder — waiting on the file, or on a timer, is
   guessing.
4. Block the tee's request pad with an `IDLE` probe, unlink, `release_request_pad`,
   then `NULL` and remove the branch's elements.

**Never send EOS to take a still branch down.** That was the first attempt and
it fails in a way worth recording: the first still is written correctly and
*every later one gets zero buffers*. EOS is sticky, so a tee pad that has
carried one is finished for good — and the failure is silent, because the
branch is added and linked exactly as before. A build that only ever tested one
still would have shipped it.

## A recording, off the encoded tee

**Start and stop both work on a live pipeline, and the file plays.** Two
recordings in a row, each finalised cleanly, with **no gap over 200 ms** on the
branch that kept streaming.

It hangs off `main` — the tee *after* the encoder — so a recording costs no
second encode. `queue ! h264parse ! matroskamux ! filesink`.

Stopping is the half that needs care, because a container has to be finalised
or the file will not play:

1. Block the tee's request pad, unlink, and release it — so no buffer is handed
   to elements on their way down.
2. **Then** send EOS into the branch's own head. It travels forward only: the
   tee's other pads and everything upstream never see it.
3. Wait for that EOS to reach the filesink's sink pad before setting the branch
   to `NULL`. Not a sleep — the muxer writes its index on EOS and a teardown
   that races it leaves an unplayable file.

## Two things that are not true, and cost a spike each

**Do not offset the branch's pad to zero.** A branch joining a pipeline that has
been up for a while carries the running time on its first buffer, and
`pad.set_offset(-running)` looks like the fix. It is not: negative timestamps
make `matroskamux` write a container `ffprobe` rejects outright — *`0x00 at pos
244 invalid as first byte of an EBML number`*. Both files were destroyed by it.

**A short recording is not necessarily a timestamp fault.** The first spike
recorded 5 s of wall time as 1.47 s, which reads exactly like a timestamp bug.
It was not: the file holds **39 frames**, and 39 frames at 30 fps *is* 1.47 s.
The container was faithful throughout. What was short was the software
`x264enc` this spike used, which held about 8 fps at 640×480 on a Pi 4.

That last point does not carry over to the board, because the recording branch
takes H.264 that the hardware encoder has already produced and encodes nothing.
**It is still unverified there**, and it is the first thing Task 33 should
measure on hardware: record a known number of seconds off the real pipeline and
check the frame count against the camera's own frame rate before anything is
built on top of it.

## What this asks of `yonder-pipeline`

The host understands two ops today, `retune` and `reconfigure-preview`, and both
manipulate elements that are already in the pipeline. Neither adds or removes
one. Stills and recording are the first things that need a branch built at
runtime, so that is new ground in the host rather than a variation on what is
there.
