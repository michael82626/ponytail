/*
 * Composer Cam: a personal camera with live composition guides.
 * Runs in Expo Go via snack.expo.dev, with everything in this one file.
 *
 * Snack packages (add them in the "package.json" tab, or accept Snack's "Add dependency" prompt):
 *   expo-camera
 *   expo-sensors
 *   expo-haptics
 *   expo-media-library
 *   react-native-svg
 *   @expo/vector-icons   (usually preinstalled in Snack)
 *
 * Gestures: swipe left or right on the preview to change the guide. Tap to focus.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Animated, Image, Linking, PanResponder, Pressable, StatusBar,
  StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { DeviceMotion } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

const PHI = (1 + Math.sqrt(5)) / 2;
const GUIDE = 'rgba(255,255,255,0.5)';
const GREEN = '#34C759';
const deg = (r) => (r * 180) / Math.PI;

const OVERLAYS = [
  { key: 'spiral', name: 'Golden Spiral' },
  { key: 'thirds', name: 'Rule of Thirds' },
  { key: 'phi', name: 'Phi Grid' },
  { key: 'diagonal', name: 'Diagonals' },
  { key: 'center', name: 'Center Cross' },
  { key: 'off', name: 'Guides Off' },
];

// targets: camera elevation in degrees (0 = straight ahead, -90 = straight down)
const MODES = [
  { name: 'Free', tip: 'Swipe to change the guide. Tap to focus.', overlay: null, targets: [], tol: 0 },
  { name: 'Landscape', tip: 'Put the horizon on a third line, not the middle', overlay: 'thirds', targets: [0], tol: 4 },
  { name: 'Portrait', tip: 'Hold the phone at eye level, place eyes on the top third', overlay: 'thirds', targets: [0], tol: 5 },
  { name: 'Food', tip: 'Shoot from directly above (90°) or at 45°', overlay: 'center', targets: [-90, -45], tol: 4 },
  { name: 'Architecture', tip: "Keep the phone vertical so buildings don't lean", overlay: 'center', targets: [0], tol: 2 },
];

// Gravity uses the iPhone (CoreMotion) frame: x = right, y = top of phone, z = out of the screen.
// shortcut: Android reports gravity with flipped signs. Add a sign flip here if you ever run this on Android.
export function angles({ x, y, z }) {
  const n = Math.hypot(x, y, z) || 1;
  return {
    roll: deg(Math.atan2(x, -y)), // 0 when upright, + when the phone is rotated clockwise
    elev: deg(Math.asin(Math.max(-1, Math.min(1, z / n)))), // + when the back camera points up
    gx: x / n,
    gy: y / n,
  };
}

const angleLabel = (a) => (Math.abs(a) < 0.5 ? 'straight' : `${Math.abs(a).toFixed(0)}° ${a > 0 ? 'up' : 'down'}`);

// Fibonacci spiral built in a φ×1 rectangle, then turned to portrait and flipped to the chosen corner (0..3).
export function spiral(corner) {
  let r = { x: 0, y: 0, w: PHI, h: 1 };
  const arcs = [];
  const boxes = [];
  for (let i = 0; i < 10; i++) {
    let s, c, a, b, sq;
    switch (i % 4) {
      case 0: s = r.h; c = [r.x + s, r.y + s]; a = [r.x, r.y + s]; b = [r.x + s, r.y]; sq = [r.x, r.y]; r = { ...r, x: r.x + s, w: r.w - s }; break;
      case 1: s = r.w; c = [r.x, r.y + s]; a = [r.x, r.y]; b = [r.x + s, r.y + s]; sq = [r.x, r.y]; r = { ...r, y: r.y + s, h: r.h - s }; break;
      case 2: s = r.h; c = [r.x + r.w - s, r.y]; a = [r.x + r.w, r.y]; b = [r.x + r.w - s, r.y + s]; sq = [r.x + r.w - s, r.y]; r = { ...r, w: r.w - s }; break;
      default: s = r.w; c = [r.x + s, r.y + r.h - s]; a = [r.x + s, r.y + r.h]; b = [r.x, r.y + r.h - s]; sq = [r.x, r.y + r.h - s]; r = { ...r, h: r.h - s };
    }
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let d = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d <= -Math.PI) d += 2 * Math.PI;
    const pts = [];
    for (let t = 0; t <= 12; t++) pts.push([c[0] + s * Math.cos(a0 + (d * t) / 12), c[1] + s * Math.sin(a0 + (d * t) / 12)]);
    arcs.push(pts);
    boxes.push([sq, [sq[0] + s, sq[1] + s]]);
  }
  const map = ([x, y]) => {
    let u = y; // transpose: the long φ side runs along the screen's height
    let v = x / PHI;
    if (corner & 1) u = 1 - u;
    if (corner & 2) v = 1 - v;
    return [u, v];
  };
  return { arcs: arcs.map((p) => p.map(map)), boxes: boxes.map((b) => b.map(map)) };
}

// Self-check (runs in development only): the spiral is continuous and the angle math holds at known poses.
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  const { arcs } = spiral(0);
  arcs.slice(1).forEach((arc, i) => {
    const end = arcs[i][arcs[i].length - 1];
    console.assert(Math.hypot(arc[0][0] - end[0], arc[0][1] - end[1]) < 1e-9, 'spiral gap');
  });
  console.assert(Math.abs(angles({ x: 0, y: -9.8, z: 0 }).roll) < 1e-9, 'upright roll');
  console.assert(Math.abs(angles({ x: 0, y: 0, z: -9.8 }).elev + 90) < 1e-9, 'face-up elevation');
  console.assert(angles({ x: 1, y: -9.8, z: 0 }).roll > 0, 'clockwise roll sign');
}

const ROTATE_ORDER = [0, 1, 3, 2]; // walks the spiral's eye clockwise around the 4 corners

function Guides({ type, corner, W, H }) {
  if (type === 'off') return null;
  const L = (x1, y1, x2, y2, k, op = 1) => (
    <Line key={k} x1={x1 * W} y1={y1 * H} x2={x2 * W} y2={y2 * H} stroke={GUIDE} strokeWidth={1} strokeOpacity={op} />
  );
  let body;
  if (type === 'thirds' || type === 'phi') {
    const f = type === 'thirds' ? [1 / 3, 2 / 3] : [1 - 1 / PHI, 1 / PHI];
    body = f.flatMap((p, i) => [L(p, 0, p, 1, `v${i}`), L(0, p, 1, p, `h${i}`)]);
  } else if (type === 'diagonal') {
    body = [L(0, 0, 1, 1, 'a'), L(1, 0, 0, 1, 'b')];
  } else if (type === 'center') {
    const cx = 0.5;
    const cy = 0.5;
    const arm = 0.06;
    body = [
      L(cx, 0, cx, 1, 'v', 0.5), L(0, cy, 1, cy, 'h', 0.5),
      L(cx - arm, cy, cx + arm, cy, 'cx'), L(cx, cy - arm * (W / H), cx, cy + arm * (W / H), 'cy'),
    ];
  } else {
    const { arcs, boxes } = spiral(corner);
    const d = arcs.map((p) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * W).toFixed(1)} ${(y * H).toFixed(1)}`).join(' ')).join(' ');
    body = [
      ...boxes.map(([[x1, y1], [x2, y2]], i) => (
        <Rect key={`r${i}`} x={Math.min(x1, x2) * W} y={Math.min(y1, y2) * H} width={Math.abs(x2 - x1) * W}
          height={Math.abs(y2 - y1) * H} stroke={GUIDE} strokeOpacity={0.4} strokeWidth={1} fill="none" />
      )),
      <Path key="s" d={d} stroke={GUIDE} strokeWidth={1.5} fill="none" />,
    ];
  }
  return <Svg width={W} height={H} style={StyleSheet.absoluteFill} pointerEvents="none">{body}</Svg>;
}

export default function App() {
  const { width: W, height: H } = useWindowDimensions();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef(null);
  const [facing, setFacing] = useState('back');
  const [flash, setFlash] = useState('off');
  const [af, setAf] = useState('off'); // 'off' = continuous autofocus, 'on' = focus once and lock
  const [overlayIdx, setOverlayIdx] = useState(1);
  const [modeIdx, setModeIdx] = useState(0);
  const [corner, setCorner] = useState(0);
  const [lastUri, setLastUri] = useState(null);
  const [busy, setBusy] = useState(false);
  const [g, setG] = useState({ x: 0, y: -9.8, z: 0 });
  const [label, setLabel] = useState({ title: '', sub: '' });
  const [focus, setFocus] = useState(null);
  const labelFade = useRef(new Animated.Value(0)).current;
  const focusFade = useRef(new Animated.Value(0)).current;
  const afTimer = useRef(null);
  const wasLevel = useRef(false);
  const wasMatch = useRef(false);

  useEffect(() => {
    DeviceMotion.setUpdateInterval(50);
    let s = { x: 0, y: -9.8, z: 0 };
    const sub = DeviceMotion.addListener(({ accelerationIncludingGravity: a }) => {
      if (!a) return;
      const k = 0.2; // low-pass filter so hand shake doesn't make the guides jitter
      s = { x: s.x + k * (a.x - s.x), y: s.y + k * (a.y - s.y), z: s.z + k * (a.z - s.z) };
      setG(s);
    });
    return () => { sub.remove(); clearTimeout(afTimer.current); };
  }, []);

  const showLabel = (title, sub = '', hold = 1200) => {
    setLabel({ title, sub });
    labelFade.stopAnimation();
    labelFade.setValue(1);
    Animated.timing(labelFade, { toValue: 0, delay: hold, duration: 500, useNativeDriver: true }).start();
  };

  const overlay = OVERLAYS[overlayIdx];
  const mode = MODES[modeIdx];

  const cycleOverlay = (step) => {
    const i = (overlayIdx + step + OVERLAYS.length) % OVERLAYS.length;
    setOverlayIdx(i);
    showLabel(OVERLAYS[i].name);
  };

  const cycleMode = () => {
    const i = (modeIdx + 1) % MODES.length;
    const m = MODES[i];
    setModeIdx(i);
    if (m.overlay) setOverlayIdx(OVERLAYS.findIndex((o) => o.key === m.overlay));
    showLabel(m.name, m.tip, 2800);
  };

  const tapFocus = (x, y) => {
    // shortcut: Expo Go's camera has no focus-at-a-point API, so a tap refocuses the whole frame and locks it for 4 s. A custom dev build could add true point focus.
    setFocus({ x, y });
    focusFade.setValue(1);
    Animated.timing(focusFade, { toValue: 0, delay: 600, duration: 400, useNativeDriver: true }).start();
    clearTimeout(afTimer.current);
    setAf('off');
    afTimer.current = setTimeout(() => {
      setAf('on');
      afTimer.current = setTimeout(() => setAf('off'), 4000);
    }, 60);
  };

  const pan = useRef(null);
  const handlers = useRef({});
  handlers.current = { cycleOverlay, tapFocus };
  if (!pan.current) {
    pan.current = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (_, { dx, dy, x0, y0 }) => {
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) handlers.current.cycleOverlay(dx < 0 ? 1 : -1);
        else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) handlers.current.tapFocus(x0, y0);
      },
    });
  }

  // Angles. The front camera points the other way, so its elevation flips.
  const a = angles(g);
  const elev = facing === 'front' ? -a.elev : a.elev;
  const flat = Math.abs(a.elev) > 60; // roll is meaningless when the phone lies flat, so show a bubble level instead
  const level = flat ? 90 - Math.abs(a.elev) < 1.5 : Math.abs(a.roll) < 1;
  const match = mode.targets.length > 0 &&
    mode.targets.some((t) => Math.abs(elev - t) <= mode.tol) && (flat || Math.abs(a.roll) < 2);

  useEffect(() => {
    if (level && !wasLevel.current) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    wasLevel.current = level;
  }, [level]);
  useEffect(() => {
    if (match && !wasMatch.current) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    wasMatch.current = match;
  }, [match]);

  const shoot = async () => {
    if (busy || !cam.current) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const photo = await cam.current.takePictureAsync({ quality: 1 });
      setLastUri(photo.uri);
      const p = await MediaLibrary.requestPermissionsAsync(true);
      if (!p.granted) {
        Alert.alert('Photos access needed', 'Allow "Add Photos Only" in Settings so pictures can be saved to your camera roll.');
        return;
      }
      // Newer SDKs use the class API. Older SDKs only have saveToLibraryAsync.
      if (MediaLibrary.Asset && MediaLibrary.Asset.create) await MediaLibrary.Asset.create(photo.uri);
      else await MediaLibrary.saveToLibraryAsync(photo.uri);
    } catch (e) {
      Alert.alert('Could not save photo', String(e && e.message ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  if (!perm) return <View style={styles.root} />;
  if (!perm.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.permText}>Composer Cam needs the camera to show guides over the live view.</Text>
        <Pressable style={styles.permBtn} onPress={requestPerm} accessibilityRole="button">
          <Text style={styles.permBtnText}>Allow Camera</Text>
        </Pressable>
      </View>
    );
  }

  const horizonW = W * 0.55;
  const levelColor = level ? GREEN : 'rgba(255,255,255,0.85)';
  const barH = 160;
  const barY = (v) => (-Math.max(-90, Math.min(90, v)) / 90) * (barH / 2); // 0 = middle, up = up
  const bubble = { x: Math.max(-1, Math.min(1, -a.gx * 4)) * 40, y: Math.max(-1, Math.min(1, a.gy * 4)) * 40 };
  const flashIcon = flash === 'off' ? 'flash-off' : flash === 'on' ? 'flash' : 'flash-outline';

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <CameraView ref={cam} style={StyleSheet.absoluteFill} facing={facing} flash={flash} autofocus={af} />
      <Guides type={overlay.key} corner={ROTATE_ORDER[corner]} W={W} H={H} />

      {/* gesture layer: swipe changes the guide, tap focuses */}
      <View style={StyleSheet.absoluteFill} {...pan.current.panHandlers} />

      {/* level: a horizon line when upright, a bubble when flat */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
        {flat ? (
          <Svg width={120} height={120}>
            <Circle cx={60} cy={60} r={44} stroke={levelColor} strokeWidth={1} fill="none" />
            <Line x1={50} y1={60} x2={70} y2={60} stroke={levelColor} strokeWidth={1} />
            <Line x1={60} y1={50} x2={60} y2={70} stroke={levelColor} strokeWidth={1} />
            <Circle cx={60 + bubble.x} cy={60 + bubble.y} r={8} fill={levelColor} fillOpacity={0.8} />
          </Svg>
        ) : (
          <View style={{ width: horizonW, alignItems: 'center', transform: [{ rotate: `${-a.roll}deg` }] }}>
            <View style={{ width: horizonW, height: level ? 2 : 1, backgroundColor: levelColor }} />
          </View>
        )}
        <Text style={[styles.degText, { color: levelColor }]}>
          {flat ? `${(90 - Math.abs(a.elev)).toFixed(1)}° off flat` : `${Math.abs(a.roll).toFixed(1)}°`}
        </Text>
      </View>

      {/* tilt indicator: where the camera points, up or down */}
      <View pointerEvents="none" style={[styles.tiltBar, { height: barH, top: H / 2 - barH / 2 }]}>
        <View style={styles.tiltTrack} />
        <View style={[styles.tiltZero, { top: barH / 2 }]} />
        {mode.targets.map((t) => (
          <View key={t} style={[styles.tiltTarget, { top: barH / 2 + barY(t) - 1 }]} />
        ))}
        <View style={[styles.tiltDot, { top: barH / 2 + barY(elev) - 5, backgroundColor: match ? GREEN : '#fff' }]} />
      </View>

      {/* focus ring */}
      {focus && (
        <Animated.View pointerEvents="none" style={[styles.focusRing, { left: focus.x - 35, top: focus.y - 35, opacity: focusFade }]} />
      )}

      {/* top bar */}
      <View style={styles.topBar}>
        <Pressable
          style={styles.iconBtn}
          accessibilityLabel={`Flash ${flash}`}
          onPress={() => setFlash((f) => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'))}
        >
          <Ionicons name={flashIcon} size={22} color={flash === 'off' ? '#fff' : '#FFD60A'} />
          {flash === 'auto' && <Text style={styles.autoA}>A</Text>}
        </Pressable>
        <View style={styles.readout} pointerEvents="none">
          <Text style={styles.readoutMain}>Tilt {angleLabel(elev)}</Text>
          {mode.targets.length > 0 && (
            <Text style={[styles.readoutSub, match && { color: GREEN }]}>
              {match ? '✓ Ideal angle' : `Target: ${mode.targets.map(angleLabel).join(' or ')}`}
            </Text>
          )}
        </View>
        <Pressable
          style={[styles.iconBtn, overlay.key !== 'spiral' && { opacity: 0 }]}
          disabled={overlay.key !== 'spiral'}
          accessibilityLabel="Rotate spiral"
          onPress={() => setCorner((c) => (c + 1) % 4)}
        >
          <Ionicons name="refresh" size={22} color="#fff" />
        </Pressable>
      </View>

      {/* fading guide/mode name */}
      <Animated.View pointerEvents="none" style={[styles.labelWrap, { opacity: labelFade }]}>
        <Text style={styles.labelTitle}>{label.title}</Text>
        {!!label.sub && <Text style={styles.labelSub}>{label.sub}</Text>}
      </Animated.View>

      {/* bottom controls */}
      <View style={styles.bottom}>
        <View style={styles.pillRow}>
          <Pressable style={styles.pill} onPress={() => cycleOverlay(1)} accessibilityLabel="Change guide">
            <Ionicons name="grid-outline" size={15} color="#fff" />
            <Text style={styles.pillText}>{overlay.name}</Text>
          </Pressable>
          <Pressable style={styles.pill} onPress={cycleMode} accessibilityLabel="Change shooting mode">
            <Ionicons name="aperture-outline" size={15} color="#fff" />
            <Text style={styles.pillText}>{mode.name}</Text>
          </Pressable>
        </View>
        <View style={styles.controls}>
          <Pressable
            style={styles.thumb}
            onPress={() => lastUri && Linking.openURL('photos-redirect://')}
            accessibilityLabel="Open Photos"
          >
            {lastUri && <Image source={{ uri: lastUri }} style={styles.thumbImg} />}
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.shutter, (pressed || busy) && { transform: [{ scale: 0.92 }] }]}
            onPress={shoot}
            accessibilityLabel="Take photo"
          >
            <View style={styles.shutterInner} />
          </Pressable>
          <Pressable
            style={styles.roundBtn}
            onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
            accessibilityLabel="Flip camera"
          >
            <Ionicons name="camera-reverse-outline" size={28} color="#fff" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  permText: { color: '#fff', fontSize: 17, textAlign: 'center', marginHorizontal: 32, marginBottom: 20 },
  permBtn: { backgroundColor: '#fff', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 22 },
  permBtnText: { color: '#000', fontSize: 16, fontWeight: '600' },
  degText: { position: 'absolute', top: '50%', marginTop: 70, fontSize: 13, fontVariant: ['tabular-nums'] },
  tiltBar: { position: 'absolute', right: 14, width: 14, alignItems: 'center' },
  tiltTrack: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.4)' },
  tiltZero: { position: 'absolute', width: 14, height: 1, backgroundColor: 'rgba(255,255,255,0.8)' },
  tiltTarget: { position: 'absolute', width: 14, height: 2, backgroundColor: GREEN },
  tiltDot: { position: 'absolute', width: 10, height: 10, borderRadius: 5 },
  focusRing: { position: 'absolute', width: 70, height: 70, borderWidth: 1.5, borderColor: '#FFD60A', borderRadius: 4 },
  topBar: {
    position: 'absolute', top: 54, left: 0, right: 0, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  iconBtn: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  autoA: { position: 'absolute', right: 8, bottom: 6, color: '#FFD60A', fontSize: 10, fontWeight: '700' },
  readout: { alignItems: 'center' },
  readoutMain: { color: '#fff', fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  readoutSub: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 2 },
  labelWrap: {
    position: 'absolute', top: '30%', alignSelf: 'center', alignItems: 'center', maxWidth: '84%',
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 14, paddingHorizontal: 18, paddingVertical: 10,
  },
  labelTitle: { color: '#fff', fontSize: 20, fontWeight: '600' },
  labelSub: { color: 'rgba(255,255,255,0.85)', fontSize: 14, marginTop: 4, textAlign: 'center' },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: 40, backgroundColor: 'rgba(0,0,0,0.35)' },
  pillRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, paddingVertical: 12 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.14)',
  },
  pillText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 32 },
  thumb: {
    width: 52, height: 52, borderRadius: 10, overflow: 'hidden',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)', backgroundColor: 'rgba(255,255,255,0.08)',
  },
  thumbImg: { width: '100%', height: '100%' },
  shutter: {
    width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff' },
  roundBtn: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
});
