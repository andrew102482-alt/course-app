"use client";

import { useEffect, useState } from "react";

export type NaverMapsStatus = "loading" | "ready" | "failed";

let status: NaverMapsStatus = "loading";
let started = false;
const listeners = new Set<(s: NaverMapsStatus) => void>();

function setStatus(next: NaverMapsStatus) {
  if (status === next) return;
  status = next;
  listeners.forEach((l) => l(next));
}

function start() {
  if (started) return;
  started = true;
  // 인증 실패(등록되지 않은 주소 등)를 알려주는 네이버 지도의 약속된 함수 이름.
  (
    window as unknown as { navermap_authFailure: () => void }
  ).navermap_authFailure = () => setStatus("failed");

  fetch("/api/maps/config")
    .then((r) => (r.ok ? r.json() : { clientId: null }))
    .catch(() => ({ clientId: null }))
    .then((data: { clientId: string | null }) => {
      if (!data.clientId) {
        setStatus("failed");
        return;
      }
      const script = document.createElement("script");
      script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(data.clientId)}`;
      script.async = true;
      script.onload = () => {
        const naver = (window as unknown as { naver?: { maps?: unknown } })
          .naver;
        if (naver?.maps && status !== "failed") setStatus("ready");
        else setStatus("failed");
      };
      script.onerror = () => setStatus("failed");
      document.head.appendChild(script);
    });
}

/** 네이버 지도 스크립트를 한 번만 불러오고 상태를 알려준다. 실패하면 임시 지도(SVG)로 대신한다. */
export function useNaverMaps(): NaverMapsStatus {
  const [s, setS] = useState<NaverMapsStatus>(status);
  useEffect(() => {
    listeners.add(setS);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setS(status);
    start();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
