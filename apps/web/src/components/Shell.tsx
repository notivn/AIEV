"use client";

/**
 * Khung ứng dụng: topbar + rail điều hướng trái + vùng làm việc + panel AI phải.
 *
 * Hai thứ ăn chỗ của vùng làm việc đều gấp được và nhớ lựa chọn:
 * - rail trái (220px ↔ 56px icon), key localStorage `aiev-nav`;
 * - panel AI phải (440px ↔ dải mỏng 40px), key `aiev-panel`.
 *
 * BỀ RỘNG DO CSS QUYẾT ĐỊNH, KHÔNG DO STATE REACT. SHELL_SCRIPT chạy trước paint
 * ghi `data-nav`/`data-panel` lên <html>, globals.css đọc thẳng hai thuộc tính đó
 * (xem khối "App shell" ở đầu globals.css). State React ở đây chỉ để nhãn aria và
 * tooltip nói đúng trạng thái - không được dùng nó để chọn class bề rộng, làm thế
 * là mỗi lần tải trang lại nháy một khung hình đúng bằng lúc rail bung ra rồi co
 * lại. Icon "gấp/mở" cũng vì lý do đó mà render CẢ HAI rồi để CSS chọn.
 *
 * Nút gấp/mở rail nằm DƯỚI ĐÁY CHÍNH CÁI RAIL, không ở header: nút điều khiển
 * cái gì thì đứng ở cái đó. Đáy rail dán cứng (sticky) nên rail dài phải cuộn
 * thì nút vẫn còn nguyên tại chỗ.
 *
 * Panel AI là một SLOT của shell chứ không phải mỗi trang tự dựng: trang khai báo
 * <ShellRightPanel title="…">…</ShellRightPanel> ở bất kỳ đâu trong cây, shell lo
 * bề rộng, chỗ chừa, nút gấp và chế độ drawer. Nhờ vậy không trang nào phải tự
 * đoán số kiểu `xl:pr-[452px]` nữa - con số đó sai ngay khi panel gấp lại.
 */

import {
  AudioLines,
  BookOpen,
  Clapperboard,
  ExternalLink,
  FileText,
  FolderOpen,
  Images,
  Languages,
  LayoutDashboard,
  ListVideo,
  MessageSquare,
  Mic,
  Palette,
  Shapes,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plug,
  Scissors,
  ScrollText,
  Settings2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getHealth, type Health } from "@/lib/api";
import { HardwareMeter } from "@/components/HardwareMeter";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UpdateBadge } from "@/components/UpdateBadge";
import { LOGO_DARK, LOGO_LIGHT } from "@/lib/brand";
import { useT } from "@/lib/i18n";

/** Mã nguồn dự án - hiện ở cuối sidebar, ngay trên badge phiên bản */
const REPO_URL = "https://github.com/notivn/AIEV";

const NAV_STORAGE_KEY = "aiev-nav";
const PANEL_STORAGE_KEY = "aiev-panel";

/**
 * Chống nháy layout: đọc lựa chọn gấp/mở TRƯỚC khung hình đầu tiên, đúng cách
 * THEME_SCRIPT trong layout.tsx làm với theme. Đặt làm phần tử đầu của shell nên
 * nó chạy lúc trình duyệt còn đang phân tích markup, xong trước khi có gì được vẽ.
 */
const SHELL_SCRIPT = `try{var d=document.documentElement,p=location.pathname.split("/");if(p[1]==="projects"&&p[3]==="editor"&&!p[4]){d.setAttribute("data-nav","collapsed")}else{var n=localStorage.getItem("${NAV_STORAGE_KEY}");if(n==="collapsed"||n==="expanded")d.setAttribute("data-nav",n)}if(localStorage.getItem("${PANEL_STORAGE_KEY}")==="collapsed")d.setAttribute("data-panel","collapsed")}catch(e){}`;

/**
 * Trang trình chỉnh sửa video (/projects/<id>/editor) - màn hình công cụ cần
 * từng pixel cho trình phát, nên rail TỰ GẤP khi vào và trả lại đúng lựa chọn
 * của người dùng khi rời trang. Lần gấp ép này KHÔNG ghi vào localStorage:
 * nó không phải lựa chọn của người dùng. (SHELL_SCRIPT ở trên làm cùng phép
 * kiểm tra đường dẫn để tải thẳng trang editor không nháy rail bung rồi co.)
 */
function isEditorPath(pathname: string): boolean {
  const parts = pathname.split("/");
  return parts[1] === "projects" && parts[3] === "editor" && !parts[4];
}

/**
 * Dưới ngưỡng này rail MẶC ĐỊNH gấp lại (xem lý do con số trong globals.css).
 * Chỉ dùng để nhãn aria nói đúng - bề rộng vẫn là việc của media query cùng số.
 */
const NAV_AUTO_COLLAPSE = "(max-width: 1439.98px)";

/**
 * Logo GitHub dạng SVG inline. Lucide đã bỏ icon thương hiệu khỏi bộ chính nên
 * không import được `Github`; dự án lại cấm icon font/PNG, nên vẽ thẳng path.
 */
function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const NAV = [
  { href: "/", label: "nav.dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "nav.projects", icon: Clapperboard },
  { href: "/images", label: "nav.images", icon: Images },
  { href: "/auto-cut", label: "nav.auto-cut", icon: Scissors },
  { href: "/text-to-video", label: "nav.text-to-video", icon: FileText },
  // Ngay dưới Text to video theo đúng yêu cầu: hai tính năng đều "đưa nội dung
  // vào, nhận video ra", để cạnh nhau người dùng khỏi phải quét cả sidebar.
  { href: "/translate-video", label: "nav.translate-video", icon: Languages },
  // Đặt ngay dưới cụm Text to video: thư viện giọng chỉ có nghĩa với tính năng
  // đó, để lẫn xuống cụm thư viện phía dưới là người dùng không tìm ra.
  { href: "/voices", label: "nav.voices", icon: Mic },
  { href: "/styles", label: "nav.styles", icon: Palette },
  // Ngay dưới Style Design: hai lớp "style" chồng nhau nên để cạnh nhau cho dễ
  // phân biệt - Style Design là màu/font/logo thương hiệu, còn cái này là chất
  // liệu và chuyển động của riêng từng video (xem CLAUDE.md mục 5.6).
  { href: "/video-styles", label: "nav.video-styles", icon: Shapes },
  { href: "/queue", label: "nav.queue", icon: ListVideo },
  { href: "/assets", label: "nav.assets", icon: FolderOpen },
  { href: "/sfx", label: "nav.sfx", icon: AudioLines },
  { href: "/prompts", label: "nav.prompts", icon: ScrollText },
  { href: "/skills", label: "nav.skills", icon: BookOpen },
  { href: "/config", label: "nav.config", icon: Settings2 },
  { href: "/connections", label: "nav.connections", icon: Plug },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function pageTitle(pathname: string): string {
  const item = NAV.filter((n) => isActive(pathname, n.href)).sort(
    (a, b) => b.href.length - a.href.length
  )[0];
  return item?.label ?? "nav.dashboard";
}

const HEALTH_POLL_MS = 30_000;

function BackendStatus() {
  const { t } = useT();
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const h = await getHealth();
        if (!alive) return;
        setHealth(h);
        setReachable(true);
      } catch {
        if (!alive) return;
        setHealth(null);
        setReachable(false);
      }
    }
    check();
    const timer = setInterval(check, HEALTH_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const ok = reachable === true && health?.ok === true;
  const label =
    reachable === null
      ? t("shell.backend-checking")
      : ok
        ? t("shell.backend-ok")
        : reachable
          ? t("shell.backend-partial")
          : t("shell.backend-unreachable");

  return (
    <div className="flex items-center gap-2" title={label}>
      <span
        className={`h-2 w-2 rounded-full ${
          ok ? "bg-[var(--success)]" : "bg-[var(--danger)]"
        } ${reachable === null ? "opacity-40" : ""}`}
      />
      <span className="hidden text-xs text-[var(--text-muted)] md:inline">
        {label}
      </span>
    </div>
  );
}

// ============================== Slot panel phải ==============================

interface ShellPanelApi {
  /** Nút DOM để ShellRightPanel portal nội dung vào - null cho tới khi shell mount */
  slot: HTMLElement | null;
  /** Đăng ký "trang này có panel phải"; trả về hàm hủy đăng ký cho useEffect */
  register: (title: string) => () => void;
}

const ShellPanelContext = createContext<ShellPanelApi | null>(null);

/**
 * Trang khai báo panel phải của mình bằng component này. Nội dung được portal
 * vào khung panel của shell, nên CÂY REACT vẫn nằm ở trang: state, SSE, chat
 * component… giữ nguyên, chỉ đổi chỗ vẽ ra màn hình.
 *
 * Gấp/mở, bề rộng, chỗ chừa và chế độ drawer đều là việc của shell - trang không
 * cần (và không được) tự tính lại.
 *
 * ```tsx
 * <ShellRightPanel title={t("ttv.ai-panel")}>
 *   {job && <JobLogBlock job={job} />}
 *   <ChatThread compact projectId={projectId} />
 * </ShellRightPanel>
 * ```
 */
export function ShellRightPanel({
  title,
  children,
}: {
  /** Tiêu đề panel - shell vẽ nó ở đầu panel và dùng làm nhãn dải mỏng lúc gấp */
  title: string;
  children: ReactNode;
}) {
  const api = useContext(ShellPanelContext);

  useEffect(() => {
    if (!api) return;
    return api.register(title);
  }, [api, title]);

  // Lượt render đầu chưa có slot (shell chưa biết là có panel) - lượt sau context
  // đổi và portal vào được. Hai lượt, không có vòng lặp.
  if (!api?.slot) return null;
  return createPortal(children, api.slot);
}

// ================================== Shell ===================================

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useT();
  const pathname = usePathname();

  // Trang nào đang khai báo panel phải (null = không có) - chỉ giữ tiêu đề dạng
  // chuỗi để setState không kéo theo ReactNode và gây render vòng.
  const [panelTitle, setPanelTitle] = useState<string | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  /** Drawer dưới 1280px - trạng thái tạm thời của phiên, cố ý KHÔNG nhớ */
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Chỉ để nhãn aria/tooltip nói đúng - bề rộng rail là việc của CSS */
  const [navCollapsed, setNavCollapsed] = useState(false);

  // Trạng thái THẤY ĐƯỢC của rail = thuộc tính data-nav mà SHELL_SCRIPT đã ghi,
  // cộng phép tự gấp theo bề rộng khi chưa có lựa chọn rõ ràng. Đọc thuộc tính
  // chứ không đọc lại localStorage: một nguồn sự thật, không sợ hai bên lệch.
  // Đây CHỈ để nhãn aria/tooltip nói đúng - bề rộng do CSS lo, nên listener này
  // có chậm một nhịp cũng không làm layout nhảy.
  const syncNav = useCallback(() => {
    const attr = document.documentElement.getAttribute("data-nav");
    if (attr === "collapsed") setNavCollapsed(true);
    else if (attr === "expanded") setNavCollapsed(false);
    else setNavCollapsed(window.matchMedia(NAV_AUTO_COLLAPSE).matches);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(NAV_AUTO_COLLAPSE);
    syncNav();
    mq.addEventListener("change", syncNav);
    return () => mq.removeEventListener("change", syncNav);
  }, [syncNav]);

  /** Lựa chọn rail người dùng bấm trong phiên này (kể cả khi localStorage bị chặn) */
  const navChoiceRef = useRef<"collapsed" | "expanded" | null>(null);

  // Vào trình chỉnh sửa: gấp rail (không ghi nhớ). Rời đi: trả lại lựa chọn của
  // người dùng - bấm mở/gấp ngay trong editor thì đó là lựa chọn mới, giữ nó.
  const onEditor = isEditorPath(pathname);
  useEffect(() => {
    if (!onEditor) return;
    const root = document.documentElement;
    root.setAttribute("data-nav", "collapsed");
    syncNav();
    return () => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(NAV_STORAGE_KEY);
      } catch {
        // localStorage bị chặn - dùng lựa chọn trong phiên (nếu có)
      }
      const pref =
        navChoiceRef.current ?? (saved === "collapsed" || saved === "expanded" ? saved : null);
      // Chưa từng chọn → bỏ thuộc tính, rail về phép tự gấp theo bề rộng màn hình
      if (pref) root.setAttribute("data-nav", pref);
      else root.removeAttribute("data-nav");
      syncNav();
    };
  }, [onEditor, syncNav]);

  const setNav = useCallback((next: boolean) => {
    navChoiceRef.current = next ? "collapsed" : "expanded";
    setNavCollapsed(next);
    // Ghi HẲN "expanded" chứ không xóa thuộc tính: xóa đi là rơi lại vào phép tự
    // gấp theo bề rộng, tức là ở màn hẹp người dùng bấm mở mà rail không mở.
    document.documentElement.setAttribute(
      "data-nav",
      next ? "collapsed" : "expanded"
    );
    try {
      localStorage.setItem(NAV_STORAGE_KEY, next ? "collapsed" : "expanded");
    } catch {
      // localStorage bị chặn - vẫn gấp/mở được cho phiên hiện tại
    }
  }, []);

  const setPanelCollapsed = useCallback((next: boolean) => {
    const root = document.documentElement;
    if (next) root.setAttribute("data-panel", "collapsed");
    else root.removeAttribute("data-panel");
    try {
      localStorage.setItem(PANEL_STORAGE_KEY, next ? "collapsed" : "expanded");
    } catch {
      // như trên
    }
  }, []);

  const register = useCallback((title: string) => {
    setPanelTitle(title);
    return () => setPanelTitle(null);
  }, []);

  const panelApi = useMemo<ShellPanelApi>(
    () => ({ slot, register }),
    [slot, register]
  );

  // Trang mobile /m/<id> (điện thoại quét QR upload) - layout riêng tối giản,
  // không header/sidebar của dashboard.
  if (pathname === "/m" || pathname.startsWith("/m/")) {
    return <>{children}</>;
  }

  // Nhãn dài dùng cho aria-label/tooltip; nhãn ngắn là chữ hiện cạnh icon trong
  // rail (rail chỉ rộng 220px, câu dài bị cắt cụt thành "Thu gọn thanh điề…").
  const navToggleLabel = navCollapsed
    ? t("shell.nav-expand")
    : t("shell.nav-collapse");
  const navToggleShort = navCollapsed
    ? t("shell.nav-expand-short")
    : t("shell.nav-collapse-short");

  return (
    <ShellPanelContext.Provider value={panelApi}>
      <div className="flex h-screen flex-col">
        <script dangerouslySetInnerHTML={{ __html: SHELL_SCRIPT }} />

        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4">
          <Link href="/" className="flex shrink-0 items-center">
            {/* Logo đổi theo theme qua CSS trong globals.css.
                Nguồn ảnh là hằng số data URI biên dịch vào bundle
                (src/lib/brand.ts), KHÔNG phải file trong public/: nhận diện của
                chính ứng dụng không được đổi bằng cách chép đè một file PNG.
                Logo người dùng tải lên ở Style Design đi đường khác hẳn
                (assets/styles → /media), chỉ dùng đóng dấu lên video. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_LIGHT} alt="noti.vn" className="logo-light h-7 w-auto" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_DARK} alt="noti.vn" className="logo-dark h-7 w-auto" />
          </Link>

          {/* Nút gấp/mở rail KHÔNG còn ở header: nó nằm dưới đáy chính cái rail
              nó điều khiển (xem `.shell-nav-head` bên dưới). */}
          <span className="min-w-0 truncate text-sm font-semibold">
            {t(pageTitle(pathname))}
          </span>

          <div className="ml-auto flex items-center gap-3">
            {panelTitle !== null && (
              <button
                type="button"
                onClick={() => setDrawerOpen((o) => !o)}
                className="shell-panel-drawer shell-icon-btn"
                aria-expanded={drawerOpen}
                aria-controls="shell-panel-body"
                aria-label={t("shell.panel-open")}
                title={t("shell.panel-open")}
              >
                <MessageSquare size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            <HardwareMeter />
            <BackendStatus />
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            id="shell-nav"
            className="shell-nav flex shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-subtle)]"
          >
            {/* Nút gấp/mở rail đứng NGAY TRÊN mục đầu tiên (Dashboard) - dán
                đỉnh (sticky) vì rail 17 mục cao hơn màn hình là phải cuộn, mà
                nút gấp cuộn mất tầm với thì coi như không có nút.
                aria-controls trỏ về #shell-nav: nút nằm trong chính vùng nó
                điều khiển, đây là mẫu disclosure hợp lệ. */}
            <div className="shell-nav-head">
              <button
                type="button"
                onClick={() => setNav(!navCollapsed)}
                className="shell-nav-toggle"
                aria-expanded={!navCollapsed}
                aria-controls="shell-nav"
                aria-label={navToggleLabel}
                title={navToggleLabel}
              >
                {/* Hai icon cùng nằm trong DOM, CSS chọn cái nào hiện - state
                    React chưa kịp đúng ở khung hình đầu, CSS thì đúng ngay */}
                <PanelLeftClose
                  size={16}
                  strokeWidth={1.75}
                  className="only-nav-expanded shrink-0"
                  aria-hidden="true"
                />
                <PanelLeftOpen
                  size={16}
                  strokeWidth={1.75}
                  className="only-nav-collapsed shrink-0"
                  aria-hidden="true"
                />
                <span className="shell-nav-label min-w-0 truncate">
                  {navToggleShort}
                </span>
              </button>
            </div>

            <nav
              className="flex flex-col gap-1"
              aria-label={t("shell.nav-aria")}
            >
              {NAV.map(({ href, label, icon: Icon }) => {
                const text = t(label);
                return (
                  <Link
                    key={href}
                    href={href}
                    // title + aria-label luôn có: lúc rail gấp thì đây là thứ
                    // duy nhất cho biết icon này là gì
                    title={text}
                    aria-label={text}
                    aria-current={isActive(pathname, href) ? "page" : undefined}
                    className={`nav-item ${isActive(pathname, href) ? "active" : ""}`}
                  >
                    <Icon size={18} strokeWidth={1.75} className="shrink-0" />
                    <span className="shell-nav-label min-w-0 truncate">
                      {text}
                    </span>
                  </Link>
                );
              })}
            </nav>

            {/* Cuối sidebar: link mã nguồn nằm TRÊN badge phiên bản - hai thứ này
                cùng nói về "bản dựng nào đang chạy" nên đứng cạnh nhau.
                `.shell-nav-foot` dán đáy (sticky) để rail dài vẫn với tới được. */}
            <div className="shell-nav-foot mt-auto flex flex-col gap-1">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer noopener"
                title={REPO_URL}
                aria-label={t("nav.source")}
                className="shell-nav-source inline-flex items-center gap-2 rounded-[var(--radius)] py-1 text-xs text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--surface)] hover:text-[var(--text)]"
              >
                <GithubMark size={14} />
                <span className="shell-nav-label min-w-0 flex-1 truncate">
                  {t("nav.source")}
                </span>
                <ExternalLink
                  size={12}
                  strokeWidth={2}
                  className="shell-nav-label shrink-0 opacity-60"
                  aria-hidden="true"
                />
              </a>
              {/* Badge phiên bản là chữ thuần, gấp rail còn 56px là không đọc
                  được nữa nên ẩn hẳn thay vì bóp vỡ */}
              <div className="shell-nav-extra flex-col">
                <UpdateBadge />
              </div>

            </div>
          </aside>

          {/* FULL WIDTH - không max-width, dùng tối đa không gian màn hình */}
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="w-full p-5">{children}</div>
          </main>

          {/* Khung panel LUÔN nằm trong DOM (rộng 0 khi trang không khai báo) -
              xem `.shell-panel.is-empty` trong globals.css để biết vì sao. */}
          <div
            className={`shell-panel-scrim ${
              drawerOpen && panelTitle !== null ? "is-open" : ""
            }`}
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside
            className={`shell-panel ${panelTitle === null ? "is-empty" : ""} ${
              drawerOpen ? "is-open" : ""
            }`}
            aria-label={panelTitle ?? undefined}
            aria-hidden={panelTitle === null ? true : undefined}
          >
            {/* Dải mỏng lúc gấp: panel KHÔNG biến mất hẳn, luôn còn 40px bấm vào
                là mở lại - biến mất hẳn thì người dùng không tìm ra đường về */}
            <button
              type="button"
              onClick={() => setPanelCollapsed(false)}
              className="shell-panel-strip"
              aria-expanded={false}
              aria-controls="shell-panel-body"
              aria-label={t("shell.panel-expand")}
              title={t("shell.panel-expand")}
            >
              <PanelRightOpen size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="shell-panel-strip-label">{panelTitle}</span>
            </button>

            <div
              id="shell-panel-body"
              className="shell-panel-body min-h-0 min-w-0 flex-1 flex-col gap-3 p-3"
            >
              <div className="flex shrink-0 items-center justify-between gap-2">
                <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                  <MessageSquare
                    size={15}
                    strokeWidth={2}
                    className="shrink-0 text-[var(--text-muted)]"
                    aria-hidden="true"
                  />
                  <span className="truncate">{panelTitle}</span>
                </h2>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPanelCollapsed(true)}
                    className="shell-panel-toggle shell-icon-btn"
                    aria-expanded={true}
                    aria-controls="shell-panel-body"
                    aria-label={t("shell.panel-collapse")}
                    title={t("shell.panel-collapse")}
                  >
                    <PanelRightClose
                      size={16}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrawerOpen(false)}
                    className="shell-panel-drawer shell-icon-btn"
                    aria-label={t("shell.panel-close")}
                    title={t("shell.panel-close")}
                  >
                    <X size={16} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>

              {/* Điểm hạ cánh của portal - nội dung panel do trang cung cấp */}
              <div ref={setSlot} className="flex min-h-0 flex-1 flex-col gap-3" />
            </div>
          </aside>
        </div>
      </div>
    </ShellPanelContext.Provider>
  );
}
