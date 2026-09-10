# SPDX-License-Identifier: GPL-3.0-or-later
"""
A GStreamer with no GStreamer in it: elements, pads, links, caps negotiation
and a stream of buffers, built from the same launch line a board would run.

**It models the graph, not the answers.** `parse_launchv` builds elements and
links from the argv `video/pipeline.ts` composes, a tee's outputs are request
pads because that is what makes them the edge of a branch, and caps propagate
downstream through capsfilters the way a real negotiation does. So the host's
walk finds its branch by walking, its continuity probe is fed real buffers
with advancing timestamps, and a property it reads back is the one it set.

**It models elements arriving and leaving, too.** A still and a recording are
branches built while the pipeline is playing, so `ElementFactory.make`,
`Pipeline.add`/`remove`, `Element.link`, a tee's request pads and
`Pad.send_event` are all here -- and a filesink writes a real file, growing
while its branch is linked, so a test can tell a recording that ran from one
that never started. An end-of-stream travels **forward only** from the pad it
is pushed into, which is the property the recording stop turns on.

**And a still is a picture.** A filesink whose chain comes through a
`jpegenc` -- which is the branch `yonder-pipeline`'s `still` op builds, and
nothing else here -- is written one whole JPEG rather than a stream of dots.
A dot per buffer answers the only question a recording asks, *did this file
grow*; it does not answer the one `scripts/verify-pages.sh` asks, which is
whether a browser can draw the frame on a console page. See `_JPEG`.

`Pad.set_offset` is here for one reason: to be recorded and never called.
Offsetting a branch's pad to zero destroyed both spike recordings, and a trace
that names the call is what makes its absence assertable.

Four switches, each turning on a failure a test needs and nothing else:

  YONDER_FAKE_GST_REFUSE_RENEGOTIATE  a capsfilter takes its new caps but
      nothing downstream renegotiates until the branch is cycled through NULL
      -- which is the case the preview-branch restart exists for.
  YONDER_FAKE_GST_GAP_AFTER_SET       the next change to the graph -- a
      property set, or an element added -- is followed by a one-second jump in
      the main branch's timestamps.
  YONDER_FAKE_GST_STALL_AFTER_SET     the same, followed by the main branch
      delivering nothing at all -- a break with no gap in it.
  YONDER_FAKE_GST_ONE_FRAME           a pad's buffer probe fires exactly once
      and never again, which is a pipeline with no *fresh* frame to give: the
      case a still must refuse rather than answer with what is already there.

  YONDER_FAKE_GST_TRACE               a file to append one JSON line per call
      to, so a test can assert what the host actually asked GStreamer for.
"""
import json
import os
import re
import threading
import time

_TRACE_LOCK = threading.Lock()


def _trace(event, **fields):
    path = os.environ.get("YONDER_FAKE_GST_TRACE")
    if not path:
        return
    fields["event"] = event
    with _TRACE_LOCK:
        with open(path, "a") as handle:
            handle.write(json.dumps(fields, sort_keys=True) + "\n")


def _on(name):
    return os.environ.get(name, "") not in ("", "0")


# -- one frame, as a picture -------------------------------------------------
#
# A still off this fake has to be a file a browser can decode, because
# `scripts/verify-pages.sh` puts one on the Camera page's picture and its
# thumbnail strip and photographs both (R-VID-14, R-UI-12). A stream of dots
# is a file that grows, which is all a recording is asked here; it is not an
# image, and an <img> holding one draws nothing at all.
#
# So this is a whole baseline JPEG, assembled from its own segments below
# rather than pasted in as a blob, so that every byte of it can be read.
#
# **1280x720, and that is not cosmetic.** The shape a still is *reported* at
# is read off the branch's own pad, so a one-pixel frame would still be
# answered as 1280x720 — and then the picture would draw a one-pixel image
# letterboxed inside a 16:9 frame, and the strip would charge a viewer for a
# hundred and forty bytes, which rounds to `0 kb/s of stills` on the readout
# blueprint L-22 is about. A frame the size the pad says it is costs neither
# of those lies.
#
# It is a flat mid-grey field, which is what an all-zero entropy stream
# decodes to, and it compresses to nothing: about 3.7 kB where a photograph
# off a board is nearer a hundred. Nothing in this tree has a camera. This is
# the picture-shaped thing a fake hands over, and it must never be mistaken
# for a photograph or its size read as a measurement.

_JPEG_WIDTH = 1280
_JPEG_HEIGHT = 720


def _jpeg_segment(marker, payload):
    length = len(payload) + 2
    return bytes([0xFF, marker, length >> 8, length & 0xFF]) + payload


def _grey_field(width, height):
    # SOI, then a quantiser whose every coefficient is 16 -- flat, because
    # there is nothing here to quantise well.
    parts = [b"\xff\xd8", _jpeg_segment(0xDB, b"\x00" + bytes([16] * 64))]
    # SOF0: baseline, 8 bits a sample, this many rows and columns, one
    # component (id 1, 1x1 sampling, quantiser 0).
    parts.append(_jpeg_segment(0xC0, bytes([
        0x08,
        height >> 8, height & 0xFF,
        width >> 8, width & 0xFF,
        0x01, 0x01, 0x11, 0x00,
    ])))
    # Two Huffman tables with one code each, a single bit long: the DC
    # category and the end-of-block are the only two symbols a flat field
    # needs, so the tables that carry them are one entry apiece.
    parts.append(_jpeg_segment(0xC4, b"\x00" + bytes([1] + [0] * 15) + b"\x00"))
    parts.append(_jpeg_segment(0xC4, b"\x10" + bytes([1] + [0] * 15) + b"\x00"))
    # SOS: one component, both tables 0, the baseline spectral selection.
    parts.append(_jpeg_segment(0xDA, b"\x01\x01\x00\x00\x3f\x00"))
    # The entropy. Every 8x8 block is two bits -- a DC difference of zero
    # ("0", category 0, no extra bits) and an end-of-block ("0") -- so the
    # whole image is zero bytes, and a zero byte needs no stuffing the way an
    # 0xFF would. A DC difference of zero is the level shift itself, which is
    # a sample of 128: mid grey.
    blocks = ((width + 7) // 8) * ((height + 7) // 8)
    parts.append(bytes((blocks * 2 + 7) // 8))
    parts.append(b"\xff\xd9")
    return b"".join(parts)


_JPEG = _grey_field(_JPEG_WIDTH, _JPEG_HEIGHT)


# -- values -----------------------------------------------------------------

_MEDIA_TYPE = re.compile(r"^[a-z]+/[a-z0-9x+._-]+$")
_BACK_REFERENCE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*\.$")
_CAST = re.compile(r"^\((?:string|int|uint|boolean|fraction)\)")


def _value(text):
    text = _CAST.sub("", text)
    if re.match(r"^-?\d+$", text):
        return int(text)
    fraction = re.match(r"^(\d+)/(\d+)$", text)
    if fraction:
        return (int(fraction.group(1)), int(fraction.group(2)))
    return text


def _fields(parts):
    out = {}
    for part in parts:
        if "=" in part:
            key, _, text = part.partition("=")
            out[key] = _value(text)
    return out


def _looks_like_caps(text):
    return bool(_MEDIA_TYPE.match(text.split(",")[0]))


def _looks_like_structure(text):
    head = text.split(",")[0]
    return "," in text and bool(re.match(r"^[a-z][a-z0-9_-]*$", head))


class Structure(object):
    def __init__(self, name, fields):
        self.name = name
        self.fields = dict(fields)

    @staticmethod
    def from_string(text):
        parts = text.split(",")
        return Structure(parts[0], _fields(parts[1:]))

    def get_name(self):
        return self.name

    def get_value(self, key):
        return self.fields.get(key)

    def get_int(self, key):
        got = self.fields.get(key)
        return (isinstance(got, int) and not isinstance(got, bool), got or 0)

    def get_fraction(self, key):
        got = self.fields.get(key)
        if isinstance(got, tuple):
            return (True, got[0], got[1])
        if isinstance(got, int):
            return (True, got, 1)
        return (False, 0, 1)

    def set_value(self, key, value):
        self.fields[key] = value

    def __repr__(self):
        return "Structure(%s,%r)" % (self.name, self.fields)


class Caps(object):
    def __init__(self, structure):
        self.structure = structure

    @staticmethod
    def from_string(text):
        parts = text.split(",")
        return Caps(Structure(parts[0], _fields(parts[1:])))

    def get_size(self):
        return 1

    def get_structure(self, index):
        return self.structure

    def is_subset(self, superset):
        if superset is None:
            return False
        mine, theirs = self.structure, superset.structure
        if mine.name != theirs.name:
            return False
        for key, want in theirs.fields.items():
            if mine.fields.get(key) != want:
                return False
        return True

    def __repr__(self):
        return "Caps(%s)" % self.structure


# -- graph ------------------------------------------------------------------

class PadTemplate(object):
    def __init__(self, presence):
        self.presence = presence


class Pad(object):
    def __init__(self, element, name, presence):
        self.element = element
        self.name = name
        self.template = PadTemplate(presence)
        self.peer = None
        self.caps = None
        self.probes = {}
        self._handles = 0

    def get_peer(self):
        return self.peer

    def get_parent_element(self):
        return self.element

    def get_pad_template(self):
        return self.template

    def get_current_caps(self):
        return self.caps

    def add_probe(self, mask, callback):
        self._handles += 1
        handle = self._handles
        self.probes[handle] = (mask, callback)
        _trace("add_probe", pad=self.path(), mask=int(mask))
        # A blocking probe on a pad nothing is pushing through fires at once,
        # which is what makes it a *block* rather than a wait.
        if mask in (PadProbeType.BLOCK_DOWNSTREAM, PadProbeType.IDLE):
            if callback(self, ProbeInfo(None)) is PadProbeReturn.REMOVE:
                self.probes.pop(handle, None)
        return handle

    def remove_probe(self, handle):
        self.probes.pop(handle, None)

    def path(self):
        return "%s.%s" % (self.element.name, self.name)

    # -- linking -----------------------------------------------------------

    def link(self, peer):
        self.peer = peer
        peer.peer = self
        _trace("link", src=self.path(), sink=peer.path())
        # **Caps travel to a pad the moment it is linked, not only when the
        # pipeline is started.** In GStreamer they are sticky events, held on
        # the source pad and delivered to whatever links to it afterwards. A
        # branch built and joined while everything else is already playing —
        # which is how a still and a recording work — has no other moment to
        # learn its shape, and without this it reports none and the host
        # answers a capture with no size on it.
        if self.caps is not None:
            _deliver_caps(peer, self.caps)
        return PadLinkReturn.OK

    def unlink(self, peer):
        if self.peer is peer:
            self.peer = None
        if peer is not None and peer.peer is self:
            peer.peer = None
        _trace("unlink", src=self.path(), sink=None if peer is None else peer.path())
        return True

    def set_offset(self, offset):
        """
        **Here to be recorded, and never called.**

        A branch joining a pipeline that has been up for a while carries the
        running time on its first buffer, and offsetting its pad to zero looks
        like the fix. It is not: negative timestamps make `matroskamux` write a
        container ffprobe rejects outright, and both spike recordings were
        destroyed by it. A trace event naming the call is what lets a test
        assert it did not happen.
        """
        _trace("set_offset", pad=self.path(), offset=int(offset))

    # -- events ------------------------------------------------------------

    def send_event(self, event):
        """
        An event pushed in at this pad, travelling **forward only**.

        That direction is the whole of why a recording can be stopped without
        the ground station noticing: an end-of-stream pushed into the branch's
        own head walks down the branch to its sink, and the tee's other pads
        and everything upstream never see it. Modelled by walking src peers
        from this pad's element and going nowhere else.
        """
        # `sent`, not `event`: `_trace`'s own first parameter is named
        # `event`, and a field of that name would collide with it.
        _trace("send_event", pad=self.path(), sent=event.type_name())
        element = self.element
        seen = set()
        while element is not None and element.name not in seen:
            seen.add(element.name)
            if event.type == EventType.EOS:
                element.saw_eos = True
            for pad in list(element.pads.values()):
                for mask, callback in list(pad.probes.values()):
                    if mask == PadProbeType.EVENT_DOWNSTREAM:
                        callback(pad, ProbeInfo(None, event))
            element = element.downstream()
        return True


class ProbeInfo(object):
    def __init__(self, buffer, event=None):
        self.buffer = buffer
        self.event = event

    def get_buffer(self):
        return self.buffer

    def get_event(self):
        return self.event


class Event(object):
    def __init__(self, kind):
        self.type = kind

    def type_name(self):
        return "eos" if self.type == EventType.EOS else "event"

    @staticmethod
    def new_eos():
        return Event(EventType.EOS)


class Buffer(object):
    def __init__(self, pts):
        self.pts = pts


def _always_pads(kind):
    """
    Which pads an element of this kind is born with.

    A tee is the exception that matters: its outputs are *requested*, and that
    is what makes them the edge of a branch — the fact `Host.walk` navigates by
    and the fact a still or a recording hangs itself on. Everything else is
    read off the name, which is how GStreamer's own elements are named:
    something ending in `src` produces, something ending in `sink` consumes,
    and everything in between does both.
    """
    if kind == "tee":
        return ("sink",)
    if kind.endswith("src"):
        return ("src",)
    if kind.endswith("sink"):
        return ("sink",)
    return ("sink", "src")


class _Factory(object):
    """`Gst.ElementFactory`, as far as `get_name()` — the kind an element was
    made as, which is the one thing the host reads off it."""
    def __init__(self, kind):
        self.kind = kind

    def get_name(self):
        return self.kind


class Element(object):
    def __init__(self, pipeline, kind, name):
        self.pipeline = pipeline
        self.kind = kind
        self.name = name
        self.props = {}
        self.pads = {}
        self.state = State.NULL
        self.requested = 0
        self.saw_eos = False
        # Whether this sink has already been handed its one frame. See
        # `_buffer` -- a still is one JPEG, not a file of them.
        self.wrote_frame = False
        for pad in _always_pads(kind):
            self._pad(pad)

    # pads
    def _pad(self, name, presence=None):
        if name not in self.pads:
            self.pads[name] = Pad(self, name, presence or PadPresence.ALWAYS)
        return self.pads[name]

    def request_src(self):
        name = "src_%d" % self.requested
        self.requested += 1
        _trace("request_pad", element=self.name, pad=name)
        return self._pad(name, PadPresence.REQUEST)

    def get_request_pad(self, template):
        """`tee.get_request_pad("src_%u")` — the call the spiked recipe makes.
        Deprecated in GStreamer 1.20 in favour of `request_pad_simple` and
        still present; both names are here so the host can be moved to the
        other one without this fake having to change first."""
        return self.request_src()

    def request_pad_simple(self, template):
        return self.request_src()

    def release_request_pad(self, pad):
        peer = pad.get_peer()
        if peer is not None:
            pad.unlink(peer)
        self.pads.pop(pad.name, None)
        _trace("release_pad", element=self.name, pad=pad.name)

    def get_static_pad(self, name):
        return self.pads.get(name)

    def get_factory(self):
        return _Factory(self.kind)

    def downstream(self):
        """The element this one's output reaches, or None. Src pads only, so a
        walk from here never goes back up the graph."""
        for name, pad in self.pads.items():
            if name == "sink":
                continue
            if pad.peer is not None:
                return pad.peer.element
        return None

    def link(self, other):
        """`Gst.Element.link` — src pad to sink pad, as a bin's elements are
        joined once they are both in it."""
        src = self.request_src() if self.kind == "tee" else self._pad("src")
        sink = other.get_static_pad("sink")
        if sink is None:
            return False
        src.link(sink)
        return True

    # properties
    def get_name(self):
        return self.name

    def get_property(self, name):
        if name not in self.props:
            raise TypeError("%s has no property %r" % (self.name, name))
        return self.props[name]

    def set_property(self, name, value):
        self.props[name] = value

    # state
    def set_state(self, state):
        self.state = state
        _trace("set_state", element=self.name, state=int(state))
        if state == State.NULL:
            self._close_file()
        return StateChangeReturn.SUCCESS

    def sync_state_with_parent(self):
        self.state = self.pipeline.state
        _trace("sync_state", element=self.name, state=int(self.state))
        if self.state == State.PLAYING:
            self.pipeline.negotiate()
            self._open_file()
        return True

    # -- a filesink that writes a real file --------------------------------
    #
    # Enough of one to tell a recording that ran from one that never started,
    # and to tell a container that was finalised from one that was not. The
    # file is created when the element comes up, grows for as long as its
    # branch is linked to something, and gets its index written only if an
    # end-of-stream reached it before it went to NULL -- which is precisely the
    # ordering the spiked teardown exists to guarantee.

    def _location(self):
        if self.kind != "filesink":
            return None
        path = self.props.get("location")
        return path if isinstance(path, str) and path else None

    def _open_file(self):
        path = self._location()
        if path is None:
            return
        with open(path, "ab"):
            pass

    def _writing(self):
        """
        A filesink is fed only while its whole chain reaches a source.

        Walked upstream rather than answered from its own pad, because that is
        the question a recording's stop turns on: unhooking the branch breaks
        the link at the *tee*, four elements away, and a file that went on
        growing after that would make "stopped" untestable here.
        """
        if self._location() is None or self.state != State.PLAYING:
            return False
        return self._fed()

    def _fed(self):
        """Whether this element's chain reaches a source — the only
        condition under which anything is handed to it."""
        element = self
        seen = set()
        while element is not None and element.name not in seen:
            seen.add(element.name)
            pad = element.get_static_pad("sink")
            if pad is None:
                return True          # a source: the chain is whole
            if pad.peer is None:
                return False         # unhooked, or never joined up
            element = pad.peer.element
        return False

    def _through(self, kind):
        """Whether this element's chain passes through one of `kind`.

        The same upstream walk `_fed` makes, asking a different question:
        what is feeding this sink decides what a buffer arriving at it looks
        like. A `jpegenc` upstream is the still branch and nothing else here
        builds one.
        """
        element = self
        seen = set()
        while element is not None and element.name not in seen:
            seen.add(element.name)
            if element.kind == kind:
                return True
            pad = element.get_static_pad("sink")
            if pad is None or pad.peer is None:
                return False
            element = pad.peer.element
        return False

    def _buffer(self):
        """One buffer, as this sink would receive it.

        A dot for a muxed recording, which is all a recording is asked: did
        this file grow while its branch was linked, and stop when it was not.

        **A whole JPEG, once, for a still.** What a real `jpegenc` hands a
        filesink is one complete image per buffer, and the host keeps the
        first buffer through its gate probe and drops every later one — so
        one frame is what actually lands on a board. Writing a JPEG per tick
        here would be a file no browser draws past its first image and a byte
        count that grows for as long as the branch is up, neither of which is
        what a still is. Empty afterwards: the pump writes nothing.
        """
        if not self._through("jpegenc"):
            return b"."
        if self.wrote_frame:
            return b""
        self.wrote_frame = True
        return _JPEG

    def _write(self, chunk):
        path = self._location()
        if path is None or not chunk:
            return
        try:
            with open(path, "ab") as handle:
                handle.write(chunk)
        except OSError:
            pass

    def _close_file(self):
        # The muxer's index, written on end-of-stream and on nothing else. A
        # teardown that raced the event leaves a file without it, which is a
        # file that will not play -- and a test can say so.
        if self._location() is not None and self.saw_eos:
            self._write(b"index")

    def __repr__(self):
        return "Element(%s %s)" % (self.kind, self.name)


class Bus(object):
    def timed_pop_filtered(self, timeout_ns, mask):
        time.sleep(min(timeout_ns / 1e9, 0.25))
        return None


class Pipeline(object):
    def __init__(self):
        self.elements = []
        self.state = State.NULL
        self.state_name = "pipeline0"
        self.name = "pipeline0"
        self._pump = None
        self._stalled = False
        self._skew_ns = 0

    # -- building ----------------------------------------------------------
    def make(self, kind, name=None):
        """One element, built and put in this pipeline. What `parse_launchv`
        does for every element on the launch line."""
        element = Element(self, kind, name or "%s%d" % (kind, len(self.elements)))
        self.elements.append(element)
        return element

    def add(self, element):
        """`Gst.Bin.add` — an element built elsewhere, put into this pipeline
        while it is running. The first thing a still or a recording does."""
        element.pipeline = self
        if element not in self.elements:
            self.elements.append(element)
        _trace("add_element", element=element.name, kind=element.kind)
        # A change to the graph, like a property set: the two continuity
        # switches turn on the break a test needs to see reported.
        self.interrupt()
        return True

    def remove(self, element):
        """`Gst.Bin.remove`. Its pads go with it, so nothing left behind can
        still be walked to."""
        for pad in list(element.pads.values()):
            if pad.peer is not None:
                pad.unlink(pad.peer)
        if element in self.elements:
            self.elements.remove(element)
        _trace("remove_element", element=element.name, kind=element.kind)
        return True

    def get_by_name(self, name):
        for element in self.elements:
            if element.name == name:
                return element
        return None

    def get_bus(self):
        return Bus()

    def link(self, upstream, downstream):
        src = upstream.request_src() if upstream.kind == "tee" else upstream._pad("src")
        sink = downstream._pad("sink")
        src.link(sink)

    # -- negotiation -------------------------------------------------------
    def negotiate(self):
        """Push caps downstream from every element that has no upstream, the
        way a real pipeline settles them. A capsfilter overrides the fields it
        carries; everything else passes them on."""
        heads = [e for e in self.elements if e.get_static_pad("sink") is None]
        seed = {"width": 1280, "height": 720, "framerate": (30, 1)}
        for head in heads:
            self._push(head, "video/x-raw", dict(seed), set())

    def _push(self, element, media, fields, seen):
        if element.name in seen:
            return
        seen = seen | {element.name}
        caps = element.props.get("caps")
        if element.kind == "capsfilter" and isinstance(caps, Caps):
            media = caps.structure.name
            fields = dict(fields)
            fields.update(caps.structure.fields)
        for name, pad in list(element.pads.items()):
            if name == "sink":
                continue
            pad.caps = Caps(Structure(media, fields))
            if pad.peer is not None:
                pad.peer.caps = pad.caps
                self._push(pad.peer.element, media, fields, seen)

    # -- running -----------------------------------------------------------
    def set_state(self, state):
        self.state = state
        _trace("set_state", element=self.name, state=int(state))
        if state == State.PLAYING:
            self.negotiate()
            self._start_pump()
        return StateChangeReturn.SUCCESS

    def _start_pump(self):
        if self._pump is not None:
            return
        self._pump = threading.Thread(target=self._flow)
        self._pump.daemon = True
        self._pump.start()

    def _flow(self):
        counts = {}
        delivered = {}
        announced = False
        while True:
            time.sleep(0.004)
            if self._stalled:
                continue
            for element in list(self.elements):
                # A filesink is fed for as long as its branch is linked. That
                # is what makes a recording a file that grows and a stopped one
                # a file that does not.
                if element._writing():
                    element._write(element._buffer())
                # **A pad whose chain does not reach a source gets no
                # buffers**, which is plainly true in GStreamer and was not
                # true here. A branch is built, its probes are added, and
                # only then is it joined to the tee — so without this a
                # still's own gate could count two buffers before the branch
                # was linked at all, the host would answer, and the file it
                # named was empty. It failed only under load, because it is a
                # race between the join and this loop.
                if not element._fed():
                    continue
                for pad in list(element.pads.values()):
                    for mask, callback in list(pad.probes.values()):
                        if mask != PadProbeType.BUFFER:
                            continue
                        key = "%s.%s" % (element.name, pad.name)
                        # One buffer and no more: a pipeline with nothing fresh
                        # to give, which is what a still has to refuse rather
                        # than answer from what is already on the disk.
                        if _on("YONDER_FAKE_GST_ONE_FRAME") and delivered.get(key, 0) >= 1:
                            continue
                        delivered[key] = delivered.get(key, 0) + 1
                        period = 33333333
                        if pad.caps is not None:
                            ok, num, den = pad.caps.structure.get_fraction("framerate")
                            if ok and num:
                                period = int(den * SECOND / num)
                        counts[key] = counts.get(key, 0) + period
                        callback(pad, ProbeInfo(Buffer(counts[key] + self._skew_ns)))
                        if not announced:
                            # So a test can wait for frames to be flowing
                            # rather than sleep and hope. The stall half of a
                            # continuity claim is only meaningful once
                            # something was arriving to stop.
                            announced = True
                            _trace("flowing", pad=key)

    def interrupt(self):
        if _on("YONDER_FAKE_GST_STALL_AFTER_SET"):
            self._stalled = True
        if _on("YONDER_FAKE_GST_GAP_AFTER_SET"):
            self._skew_ns += SECOND


# -- module-level API -------------------------------------------------------

class _Enum(int):
    pass


class State(object):
    NULL = _Enum(1)
    READY = _Enum(2)
    PAUSED = _Enum(3)
    PLAYING = _Enum(4)


class StateChangeReturn(object):
    FAILURE = _Enum(0)
    SUCCESS = _Enum(1)
    ASYNC = _Enum(2)
    NO_PREROLL = _Enum(3)



def _deliver_caps(pad, caps, seen=None):
    """The caps a newly linked pad inherits, and everything downstream of it.

    `Pipeline.negotiate` does this for a graph that is joined up before it
    plays; this is the same walk for a branch joined after."""
    seen = set() if seen is None else seen
    element = pad.element
    if element is None or element.name in seen:
        return
    seen = seen | {element.name}
    pad.caps = caps
    for name, downstream in list(element.pads.items()):
        if name == "sink":
            continue
        downstream.caps = caps
        if downstream.peer is not None:
            _deliver_caps(downstream.peer, caps, seen)


class PadProbeType(object):
    BUFFER = _Enum(1)
    BLOCK_DOWNSTREAM = _Enum(2)
    IDLE = _Enum(3)
    EVENT_DOWNSTREAM = _Enum(4)


class PadProbeReturn(object):
    OK = _Enum(0)
    DROP = _Enum(1)
    # A probe that has done its one job and wants to be gone. `Branch.start`
    # joins the tee from inside an IDLE probe and returns this, so the link is
    # made once and the probe does not sit on a pad that is about to stream.
    REMOVE = _Enum(2)


class PadLinkReturn(object):
    OK = _Enum(0)
    WRONG_HIERARCHY = _Enum(-1)


class PadPresence(object):
    ALWAYS = _Enum(0)
    SOMETIMES = _Enum(1)
    REQUEST = _Enum(2)


class MessageType(object):
    ERROR = _Enum(1)
    EOS = _Enum(2)


class EventType(object):
    EOS = _Enum(1)


class ElementFactory(object):
    """`Gst.ElementFactory.make` — an element built on its own, before any
    pipeline has it. Every element a still or a recording is made of arrives
    this way, which is what makes those two ops the first here to change the
    graph rather than a property on it."""

    @staticmethod
    def make(kind, name=None):
        return Element(None, kind, name or "%s-%d" % (kind, next(_SERIAL)))


def _serial():
    n = 0
    while True:
        n += 1
        yield n


_SERIAL = _serial()


SECOND = 1000000000


def init(argv):
    _trace("init")


def parse_launchv(tokens):
    """The argv, split into chains at `!` and at a `name.` back-reference,
    exactly as gst-launch reads it."""
    _trace("parse_launchv", tokens=list(tokens))
    pipeline = Pipeline()
    segments = []
    current = []
    for token in tokens:
        if token == "!":
            segments.append(current)
            current = []
        elif _BACK_REFERENCE.match(token):
            # `tee name=raw raw. ! queue` -- a back-reference starts a new
            # chain with no `!` before it, so it is its own boundary. Missing
            # this reads the reference as a property of the tee and every
            # branch after the first is lost.
            if current:
                segments.append(current)
            segments.append([token])
            current = []
        else:
            current.append(token)
    segments.append(current)

    previous = None
    for segment in segments:
        if not segment:
            continue
        head = segment[0]
        if head.endswith(".") and len(head) > 1:
            previous = pipeline.get_by_name(head[:-1])
            if previous is None:
                raise ValueError("no element named %s" % head[:-1])
            continue
        if _looks_like_caps(head) and "=" not in head.split(",")[0]:
            element = pipeline.make("capsfilter")
            element.props["caps"] = Caps.from_string(",".join(segment))
        else:
            name = None
            for token in segment[1:]:
                if token.startswith("name="):
                    name = token[len("name="):]
            element = pipeline.make(head, name)
            for token in segment[1:]:
                if "=" not in token or token.startswith("name="):
                    continue
                key, _, text = token.partition("=")
                element.props[key] = _typed(text)
        if previous is not None:
            pipeline.link(previous, element)
        previous = element
    return pipeline


def _typed(text):
    if _looks_like_caps(text):
        return Caps.from_string(text)
    if _looks_like_structure(text):
        return Structure.from_string(text)
    return _value(text)


def util_set_object_arg(element, name, value):
    """gst-launch's own string-to-property conversion: the type is taken from
    what the property already holds, so a runtime instruction carrying the
    same string as a launch-line token means the same thing."""
    _trace("set_arg", element=element.get_name(), property=name, value=value)
    held = element.props.get(name)
    if isinstance(held, Caps):
        element.props[name] = Caps.from_string(value)
    elif isinstance(held, Structure):
        element.props[name] = Structure.from_string(value)
    elif isinstance(held, int) and not isinstance(held, bool):
        element.props[name] = _value(value)
    else:
        element.props[name] = _typed(value)
    element.pipeline.interrupt()
    if not _on("YONDER_FAKE_GST_REFUSE_RENEGOTIATE"):
        element.pipeline.negotiate()


class _Gst(object):
    Structure = Structure
    Caps = Caps
    Event = Event
    EventType = EventType
    ElementFactory = ElementFactory
    State = State
    StateChangeReturn = StateChangeReturn
    PadProbeType = PadProbeType
    PadProbeReturn = PadProbeReturn
    PadLinkReturn = PadLinkReturn
    PadPresence = PadPresence
    MessageType = MessageType
    SECOND = SECOND
    init = staticmethod(init)
    parse_launchv = staticmethod(parse_launchv)
    util_set_object_arg = staticmethod(util_set_object_arg)


Gst = _Gst()
