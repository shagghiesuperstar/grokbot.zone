#!/usr/bin/env python3
"""Generates the RML sources for the two motion assets. Pure shapes + one looping
timeline each: no scripts, so the unsigned .riv loads in every web runtime."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent / "rive"
OLO, MINT = "00FFCC", "00FF99"

def kf(frame, value):
    f = f' frame="{frame}"' if frame else ""
    return f'<KeyFrameDouble value="{value}" interpolationType="linear"{f}/>'

def keyed(obj_id, prop_key, frames):
    inner = "".join(kf(f, v) for f, v in frames)
    return f'<KeyedObject objectId="{obj_id}"><KeyedProperty propertyKey="{prop_key}">{inner}</KeyedProperty></KeyedObject>'

def machine(anim_id):
    return f'''<StateMachine name="State Machine 1" id="0:7">
            <StateMachineLayer name="Layer 1" id="0:8">
                <AnyState x="200" y="-120"/>
                <ExitState x="400" y="-120"/>
                <EntryState><StateTransition stateToId="0:12"/></EntryState>
                <AnimationState x="200" animationId="{anim_id}" id="0:12"/>
            </StateMachineLayer>
        </StateMachine>'''

def shape(name, sid, x, y, w, h, rgb, alpha, kind="Rectangle", stroke=None):
    a = f"{alpha:02X}"
    if stroke:
        paint = f'<Stroke thickness="{stroke}" cap="round"><SolidColor colorValue="{a}{rgb}"/></Stroke>'
    else:
        paint = f'<Fill><SolidColor colorValue="{a}{rgb}"/></Fill>'
    return f'<Shape x="{x}" y="{y}" name="{name}" id="{sid}"><{kind} width="{w}" height="{h}"/>{paint}</Shape>'

# ---------- hero-grid: 1440x480 ambient field, 720-frame (12 s) loop ----------
W, H, LOOP = 1440, 480, 720
parts, anims, n = [], [], 100
for i in range(0, 17):
    parts.append(shape(f"v{i}", "", 90 * i, H // 2, 1.5, H, OLO, 0x1C).replace(' id=""', ""))
for j in range(0, 6):
    parts.append(shape(f"h{j}", "", W // 2, 96 * j, W, 1.5, OLO, 0x1C).replace(' id=""', ""))
# Travelling energy: horizontal sweeps, staggered, parked off-canvas between runs.
for k, (row, start) in enumerate([(1, 0), (2, 120), (3, 60), (4, 240), (2, 300), (3, 180)]):
    sid = f"0:{n}"; n += 1
    parts.append(shape(f"sweep{k}", sid, -200, 96 * row, 180, 3, OLO, 0xCC))
    end = start + 420
    anims.append(keyed(sid, 13, [(0, -200), (start, -200), (end, W + 200), (LOOP, W + 200)] if start else [(0, -200), (end, W + 200), (LOOP, W + 200)]))
# Vertical sweeps
for k, (col, start) in enumerate([(3, 30), (8, 210), (13, 120)]):
    sid = f"0:{n}"; n += 1
    parts.append(shape(f"vsweep{k}", sid, 90 * col, -120, 3, 120, OLO, 0xB0))
    end = start + 360
    anims.append(keyed(sid, 14, [(0, -120), (start, -120), (end, H + 120), (LOOP, H + 120)]))
# Ambient nodes at intersections breathe (mint: glow only, never a control).
for k, (col, row, peak) in enumerate([(2, 1, 120), (5, 3, 300), (8, 2, 480), (11, 4, 600), (14, 1, 240), (6, 5, 420)]):
    sid = f"0:{n}"; n += 1
    parts.append(shape(f"node{k}", sid, 90 * col, 96 * row, 10, 10, MINT, 0xFF, kind="Ellipse"))
    anims.append(keyed(sid, 18, [(0, 0.1), (peak, 0.85), (LOOP, 0.1)]))
hero = f'''<Rive version="1" kind="fragment">
    <Artboard defaultStateMachineId="0:7" styleId="0:3" width="{W}" height="{H}" name="HeroGrid" id="0:2">
        <LayoutComponentStyle id="0:3"/>
        {"".join(parts)}
        {machine("0:6")}
        <LinearAnimation loopValue="loop" duration="{LOOP}" name="Drift" id="0:6">{"".join(anims)}</LinearAnimation>
    </Artboard>
</Rive>
'''

# ---------- bot-pulse: 64x64 trending marker, 90-frame (1.5 s) loop ----------
pulse = None  # assembled below
# One KeyedObject may hold several KeyedProperty children: build the ring track explicitly.
ring = ('<KeyedObject objectId="0:31">'
        f'<KeyedProperty propertyKey="16">{kf(0,0.5)}{kf(90,2.0)}</KeyedProperty>'
        f'<KeyedProperty propertyKey="17">{kf(0,0.5)}{kf(90,2.0)}</KeyedProperty>'
        f'<KeyedProperty propertyKey="18">{kf(0,0.95)}{kf(90,0)}</KeyedProperty>'
        '</KeyedObject>')
core = keyed("0:30", 18, [(0, 1.0), (45, 0.7), (90, 1.0)])
pulse = f'''<Rive version="1" kind="fragment">
    <Artboard defaultStateMachineId="0:7" styleId="0:3" width="64" height="64" name="BotPulse" id="0:2">
        <LayoutComponentStyle id="0:3"/>
        {shape("core", "0:30", 32, 32, 16, 16, OLO, 0xFF, kind="Ellipse")}
        {shape("ring", "0:31", 32, 32, 28, 28, OLO, 0xFF, kind="Ellipse", stroke=3)}
        {machine("0:6")}
        <LinearAnimation loopValue="loop" duration="90" name="Pulse" id="0:6">{ring}{core}</LinearAnimation>
    </Artboard>
</Rive>
'''

for name, body in [("hero-grid", hero), ("bot-pulse", pulse)]:
    d = ROOT / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "rive.yaml").write_text(f"name: {name}\n")
    (d / "scene.rml").write_text(body)
print("wrote RML sources")
