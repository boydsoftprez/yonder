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

Three switches, each turning on a failure a test needs and nothing else:

  YONDER_FAKE_GST_REFUSE_RENEGOTIATE  a capsfilter takes its new caps but
      nothing downstream renegotiates until the branch is cycled through NULL
      -- which is the case the preview-branch restart exists for.
  YONDER_FAKE_GST_GAP_AFTER_SET       the next property set is followed by a
      one-second jump in the main branch's timestamps.
  YONDER_FAKE_GST_STALL_AFTER_SET     the next property set is followed by the
      main branch delivering nothing at all -- a break with no gap in it.

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

    def get_peer(self):
        return self.peer

    def get_parent_element(self):
        return self.element

    def get_pad_template(self):
        return self.template

    def get_current_caps(self):
        return self.caps

    def add_probe(self, mask, callback):
        handle = len(self.probes) + 1
        self.probes[handle] = (mask, callback)
        _trace("add_probe", pad="%s.%s" % (self.element.name, self.name), mask=int(mask))
        if mask == PadProbeType.BLOCK_DOWNSTREAM:
            callback(self, ProbeInfo(None))
        return handle

    def remove_probe(self, handle):
        self.probes.pop(handle, None)


class ProbeInfo(object):
    def __init__(self, buffer):
        self.buffer = buffer

    def get_buffer(self):
        return self.buffer


class Buffer(object):
    def __init__(self, pts):
        self.pts = pts


class Element(object):
    def __init__(self, pipeline, kind, name):
        self.pipeline = pipeline
        self.kind = kind
        self.name = name
        self.props = {}
        self.pads = {}
        self.state = State.NULL
        self.requested = 0

    # pads
    def _pad(self, name, presence=None):
        if name not in self.pads:
            self.pads[name] = Pad(self, name, presence or PadPresence.ALWAYS)
        return self.pads[name]

    def request_src(self):
        name = "src_%d" % self.requested
        self.requested += 1
        return self._pad(name, PadPresence.REQUEST)

    def get_static_pad(self, name):
        return self.pads.get(name)

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
        return StateChangeReturn.SUCCESS

    def sync_state_with_parent(self):
        self.state = self.pipeline.state
        _trace("sync_state", element=self.name, state=int(self.state))
        if self.state == State.PLAYING:
            self.pipeline.negotiate()
        return True

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
    def add(self, kind, name=None):
        element = Element(self, kind, name or "%s%d" % (kind, len(self.elements)))
        self.elements.append(element)
        return element

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
        src.peer = sink
        sink.peer = src

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
        announced = False
        while True:
            time.sleep(0.004)
            if self._stalled:
                continue
            for element in list(self.elements):
                for pad in list(element.pads.values()):
                    for mask, callback in list(pad.probes.values()):
                        if mask != PadProbeType.BUFFER:
                            continue
                        key = "%s.%s" % (element.name, pad.name)
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


class PadProbeType(object):
    BUFFER = _Enum(1)
    BLOCK_DOWNSTREAM = _Enum(2)


class PadProbeReturn(object):
    OK = _Enum(0)


class PadPresence(object):
    ALWAYS = _Enum(0)
    SOMETIMES = _Enum(1)
    REQUEST = _Enum(2)


class MessageType(object):
    ERROR = _Enum(1)
    EOS = _Enum(2)


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
            element = pipeline.add("capsfilter")
            element.props["caps"] = Caps.from_string(",".join(segment))
        else:
            name = None
            for token in segment[1:]:
                if token.startswith("name="):
                    name = token[len("name="):]
            element = pipeline.add(head, name)
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
    State = State
    StateChangeReturn = StateChangeReturn
    PadProbeType = PadProbeType
    PadProbeReturn = PadProbeReturn
    PadPresence = PadPresence
    MessageType = MessageType
    SECOND = SECOND
    init = staticmethod(init)
    parse_launchv = staticmethod(parse_launchv)
    util_set_object_arg = staticmethod(util_set_object_arg)


Gst = _Gst()
