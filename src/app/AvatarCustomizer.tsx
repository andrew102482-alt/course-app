"use client";

import { useState } from "react";
import {
  AVATAR_ACCESSORIES,
  AVATAR_CHARACTERS,
  saveAvatar,
  type Avatar,
} from "./avatar";

/** 캐릭터 이모지 위에 소품 이모지를 얹어 보여주는 아바타. */
export function AvatarFigure({
  avatar,
  size = "text-5xl",
}: {
  avatar: Avatar;
  size?: string;
}) {
  return (
    <span className="relative inline-flex flex-col items-center leading-none">
      {avatar.accessory && (
        <span
          className="leading-none"
          style={{ fontSize: "0.55em", marginBottom: "-0.35em" }}
        >
          {avatar.accessory}
        </span>
      )}
      <span className={size}>{avatar.character}</span>
    </span>
  );
}

/** 아바타 꾸미기 화면(전체 화면). 고르는 즉시 이 기기에 저장된다. */
export function AvatarCustomizer({
  initial,
  onChange,
  onClose,
}: {
  initial: Avatar;
  onChange: (avatar: Avatar) => void;
  onClose: () => void;
}) {
  const [avatar, setAvatar] = useState<Avatar>(initial);

  function update(next: Avatar) {
    setAvatar(next);
    saveAvatar(next);
    onChange(next);
  }

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-white dark:bg-black">
      <div className="mx-auto flex w-full max-w-md items-center gap-3 px-4 pt-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="뒤로"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-300 text-lg dark:border-zinc-700 dark:text-white"
        >
          ←
        </button>
        <h2 className="text-xl font-bold text-black dark:text-white">
          아바타 꾸미기
        </h2>
      </div>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 overflow-y-auto px-4 py-6">
        <div className="flex h-44 items-center justify-center rounded-2xl bg-gradient-to-b from-sky-200 to-amber-100 dark:from-slate-800 dark:to-amber-950">
          <AvatarFigure avatar={avatar} size="text-8xl" />
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            캐릭터
          </h3>
          <div className="grid grid-cols-5 gap-2">
            {AVATAR_CHARACTERS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`캐릭터 ${c}`}
                aria-pressed={avatar.character === c}
                onClick={() => update({ ...avatar, character: c })}
                className={`flex h-14 items-center justify-center rounded-xl border text-3xl ${
                  avatar.character === c
                    ? "border-black bg-zinc-100 dark:border-white dark:bg-zinc-800"
                    : "border-zinc-300 dark:border-zinc-700"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            소품
          </h3>
          <div className="grid grid-cols-4 gap-2">
            {AVATAR_ACCESSORIES.map((a) => (
              <button
                key={a || "none"}
                type="button"
                aria-label={a ? `소품 ${a}` : "소품 없음"}
                aria-pressed={avatar.accessory === a}
                onClick={() => update({ ...avatar, accessory: a })}
                className={`flex h-14 items-center justify-center rounded-xl border text-2xl ${
                  avatar.accessory === a
                    ? "border-black bg-zinc-100 dark:border-white dark:bg-zinc-800"
                    : "border-zinc-300 dark:border-zinc-700"
                }`}
              >
                {a || <span className="text-sm text-zinc-500">없음</span>}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="mx-auto w-full max-w-md px-4 pb-6">
        <button
          type="button"
          onClick={onClose}
          className="h-14 w-full rounded-xl bg-black text-lg font-semibold text-white dark:bg-white dark:text-black"
        >
          완료
        </button>
      </div>
    </div>
  );
}
