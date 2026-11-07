"use client";

const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "1. 수집하는 정보",
    body: [
      "네이버 로그인: 이름(없으면 별명)과 네이버가 부여한 고유 번호. 로그인 유지를 위해 서명된 쿠키에만 담고, 서버에 따로 저장하지 않습니다.",
      "위치 정보: 내 위치 표시와 길 안내를 위해 브라우저의 위치 권한으로 받습니다. 서버로 보내거나 저장하지 않습니다.",
      "입력한 내용: 일정 단계, 날짜, 만나는·헤어지는 시간, '어떤 하루를 보내고 싶으신가요?'에 적은 글.",
      "이 기기에 저장되는 정보: 닉네임, 아바타 모양, 최근 입력 조건, 저장한 코스, 개인 코드, 친구·그룹 정보(임시 기능). 모두 내 브라우저에만 있고 서버에 올라가지 않습니다.",
    ],
  },
  {
    title: "2. 이용 목적",
    body: ["코스 추천과 길 안내, 로그인 유지, 앱 설정 기억."],
  },
  {
    title: "3. 외부로 전달되는 정보",
    body: [
      "AI 코스 추천을 쓰면 입력한 글, 시간, 단계와 후보 장소 정보가 AI 서비스(BAZE API 게이트웨이를 통해 연결된 AI 모델)로 전송되어 추천 결과를 만드는 데 쓰입니다. 이름·위치는 보내지 않습니다.",
      "네이버 로그인을 쓰면 로그인 과정에서 네이버와 정보를 주고받습니다.",
    ],
  },
  {
    title: "4. 보관과 삭제",
    body: [
      "로그인 쿠키는 최대 30일 유지되며, 설정의 '로그아웃'을 누르면 바로 삭제됩니다.",
      "이 기기에 저장된 정보는 브라우저의 사이트 데이터를 지우면 삭제됩니다.",
    ],
  },
  {
    title: "5. 문의",
    body: ["문의 이메일: (운영자가 입력해 주세요)"],
  },
];

/** 개인정보처리방침(초안). 공개 전에 운영자 정보 입력과 법률 검토가 필요하다. */
export function PrivacyPolicySheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-black">
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
          개인정보처리방침
        </h2>
      </div>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 overflow-y-auto px-4 py-6">
        <p className="rounded-lg bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">
          초안입니다. 공개 전에 운영자 정보와 법률 검토가 필요해요.
        </p>
        {SECTIONS.map((section) => (
          <section key={section.title} className="flex flex-col gap-2">
            <h3 className="text-base font-semibold text-black dark:text-white">
              {section.title}
            </h3>
            {section.body.map((text) => (
              <p
                key={text}
                className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300"
              >
                {text}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
