"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef } from "react";

export type LatLng = { lat: number; lng: number };

export type MapMarker = LatLng & {
  id: string;
  /** number: 번호 원 / ghost: 흐린 번호 없는 원 / candidate: 후보 / preview: 고른 후보 / avatar: 내 위치 / pin: 빨간 핀 / dot: 작은 점 */
  kind: "number" | "ghost" | "candidate" | "preview" | "avatar" | "pin" | "dot";
  text?: string;
  label?: string;
  dim?: boolean;
  gray?: boolean;
  onClick?: () => void;
};

export type MapLine = {
  id: string;
  path: LatLng[];
  color: string;
  dashed?: boolean;
  weight?: number;
};

export type MapBubble = LatLng & { id: string; text: string };

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

const LABEL_STYLE =
  "position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:2px;white-space:nowrap;font-size:11px;font-weight:600;color:#27272a;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;pointer-events:none;";

function markerHtml(m: MapMarker): { html: string; ax: number; ay: number } {
  const label = m.label
    ? `<span style="${LABEL_STYLE}">${esc(m.label)}</span>`
    : "";
  const op = m.dim ? "opacity:.45;" : "";
  switch (m.kind) {
    case "number":
      return {
        html: `<div style="position:relative;${op}"><div style="width:24px;height:24px;border-radius:50%;background:${m.gray ? "#71717a" : "#3b82f6"};color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${esc(m.text ?? "")}</div>${label}</div>`,
        ax: 12,
        ay: 12,
      };
    case "ghost":
      return {
        html: `<div style="position:relative;opacity:.6;"><div style="width:18px;height:18px;border-radius:50%;background:#a1a1aa;border:2px solid #fff;"></div>${label}</div>`,
        ax: 9,
        ay: 9,
      };
    case "candidate":
      return {
        html: `<div style="position:relative;${op}"><div style="width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #71717a;box-shadow:0 1px 3px rgba(0,0,0,.3);"></div></div>`,
        ax: 8,
        ay: 8,
      };
    case "preview":
      return {
        html: `<div style="position:relative;"><div style="width:20px;height:20px;border-radius:50%;background:#3b82f6;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);"></div>${label}</div>`,
        ax: 10,
        ay: 10,
      };
    case "avatar":
      return {
        html: `<div style="width:36px;height:36px;border-radius:50%;background:rgba(59,130,246,.15);border:2px solid rgba(96,165,250,.5);display:flex;align-items:center;justify-content:center;font-size:20px;">🧍</div>`,
        ax: 18,
        ay: 18,
      };
    case "pin":
      return {
        html: `<div style="width:20px;height:20px;border-radius:50%;background:#ef4444;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;"><div style="width:7px;height:7px;border-radius:50%;background:#fff;"></div></div>`,
        ax: 10,
        ay: 10,
      };
    case "dot":
      return {
        html: `<div style="position:relative;"><div style="width:8px;height:8px;border-radius:50%;background:#71717a;"></div><span style="position:absolute;left:12px;top:-3px;white-space:nowrap;font-size:11px;color:#52525b;text-shadow:0 0 3px #fff,0 0 3px #fff;pointer-events:none;">${esc(m.label ?? "")}</span></div>`,
        ax: 4,
        ay: 4,
      };
  }
}

/**
 * 네이버 지도(Dynamic Map)를 그리는 공용 판. 마커·선·말풍선을 받아 그대로 올린다.
 * 반드시 `useNaverMaps()`가 "ready"일 때만 쓴다.
 * - fitKey가 바뀔 때마다 표시한 모든 점이 보이게 맞춘다(undefined면 맞추지 않고 initialCenter에서 시작).
 */
export default function NaverMapCanvas({
  markers,
  lines = [],
  bubbles = [],
  fitKey,
  initialCenter,
  initialZoom = 16,
  onMapClick,
  ariaLabel,
  className = "h-full w-full",
}: {
  markers: MapMarker[];
  lines?: MapLine[];
  bubbles?: MapBubble[];
  fitKey?: string;
  initialCenter?: LatLng;
  initialZoom?: number;
  onMapClick?: (p: LatLng) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const clickRef = useRef(onMapClick);
  const dataRef = useRef({ markers, lines, bubbles });
  // 최신 값을 다른 effect들이 읽을 수 있게, 가장 먼저 실행되는 effect에서 갱신한다.
  useEffect(() => {
    clickRef.current = onMapClick;
    dataRef.current = { markers, lines, bubbles };
  });

  // 지도 만들기(한 번)
  useEffect(() => {
    const naver = (window as any).naver;
    if (!boxRef.current || !naver?.maps) return;
    const first = markers[0] ??
      initialCenter ?? { lat: 37.5759, lng: 126.9825 };
    const map = new naver.maps.Map(boxRef.current, {
      center: new naver.maps.LatLng(first.lat, first.lng),
      zoom: initialZoom,
      scaleControl: false,
      mapDataControl: false,
      logoControl: true,
    });
    mapRef.current = map;
    const listener = naver.maps.Event.addListener(map, "click", (e: any) => {
      clickRef.current?.({ lat: e.coord.lat(), lng: e.coord.lng() });
    });
    const ro = new ResizeObserver(() => {
      const el = boxRef.current;
      if (el) map.setSize(new naver.maps.Size(el.clientWidth, el.clientHeight));
    });
    ro.observe(boxRef.current);
    return () => {
      ro.disconnect();
      naver.maps.Event.removeListener(listener);
      overlaysRef.current.forEach((o) => o.setMap(null));
      overlaysRef.current = [];
      map.destroy();
      mapRef.current = null;
    };
    // 지도는 처음 한 번만 만든다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 마커·선·말풍선 다시 그리기
  useEffect(() => {
    const naver = (window as any).naver;
    const map = mapRef.current;
    if (!naver?.maps || !map) return;
    overlaysRef.current.forEach((o) => o.setMap(null));
    const next: any[] = [];

    for (const l of lines) {
      next.push(
        new naver.maps.Polyline({
          map,
          path: l.path.map((p) => new naver.maps.LatLng(p.lat, p.lng)),
          strokeColor: l.color,
          strokeWeight: l.weight ?? 4,
          strokeOpacity: 0.9,
          strokeStyle: l.dashed ? "shortdash" : "solid",
        }),
      );
    }
    for (const b of bubbles) {
      next.push(
        new naver.maps.Marker({
          map,
          position: new naver.maps.LatLng(b.lat, b.lng),
          clickable: false,
          zIndex: 50,
          icon: {
            content: `<div style="transform:translate(-50%,-50%);white-space:nowrap;padding:2px 8px;border-radius:999px;background:#fff;border:1.5px solid #3b82f6;color:#2563eb;font-size:11px;font-weight:600;">${esc(b.text)}</div>`,
            anchor: new naver.maps.Point(0, 0),
          },
        }),
      );
    }
    for (const m of markers) {
      const { html, ax, ay } = markerHtml(m);
      const marker = new naver.maps.Marker({
        map,
        position: new naver.maps.LatLng(m.lat, m.lng),
        clickable: !!m.onClick,
        zIndex: m.kind === "preview" || m.kind === "pin" ? 120 : 100,
        icon: { content: html, anchor: new naver.maps.Point(ax, ay) },
      });
      if (m.onClick) {
        naver.maps.Event.addListener(marker, "click", () => {
          dataRef.current.markers.find((x) => x.id === m.id)?.onClick?.();
        });
      }
      next.push(marker);
    }
    overlaysRef.current = next;
  }, [markers, lines, bubbles]);

  // 모든 점이 보이게 맞추기
  useEffect(() => {
    const naver = (window as any).naver;
    const map = mapRef.current;
    if (!naver?.maps || !map || fitKey === undefined) return;
    const pts: LatLng[] = [
      ...dataRef.current.markers,
      ...dataRef.current.lines.flatMap((l) => l.path),
    ];
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setCenter(new naver.maps.LatLng(pts[0].lat, pts[0].lng));
      map.setZoom(16);
      return;
    }
    const bounds = new naver.maps.LatLngBounds(
      new naver.maps.LatLng(pts[0].lat, pts[0].lng),
      new naver.maps.LatLng(pts[0].lat, pts[0].lng),
    );
    pts.forEach((p) => bounds.extend(new naver.maps.LatLng(p.lat, p.lng)));
    map.fitBounds(bounds, { top: 50, right: 40, bottom: 40, left: 40 });
  }, [fitKey]);

  return (
    <div
      ref={boxRef}
      role="application"
      aria-label={ariaLabel ?? "네이버 지도"}
      className={className}
    />
  );
}
