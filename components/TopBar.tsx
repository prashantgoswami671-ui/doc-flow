"use client";

import { useState } from "react";
import Link from "next/link";

type NavItem = {
  label: string;
  href: string;
};

/**
 * DocFlow information architecture. "Home" is a real route; the remaining
 * categories point to in-page anchors on the existing homepage sections
 * until dedicated category routes exist (Task 5 is navigation-foundation
 * only — see docs/task-05).
 */
const NAV_ITEMS: NavItem[] = [
  { label: "Home", href: "/" },
  { label: "Organize", href: "#organize" },
  { label: "Create", href: "#create" },
  { label: "Convert", href: "#convert" },
  { label: "Enhance", href: "#enhance" },
  { label: "Protect", href: "#protect" },
];

/**
 * Primary application navigation. Presentation/navigation only — must not
 * import PDF services, manage documents, or hold business state.
 */
export default function TopBar() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <header className="w-full border-b border-gray-200 bg-white">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded-sm"
        >
          DocFlow
        </Link>

        {/* Desktop navigation */}
        <nav aria-label="Primary" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href}
                  aria-current={item.href === "/" ? "page" : undefined}
                  className="inline-block border-b-2 border-transparent px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 aria-[current=page]:border-blue-600 aria-[current=page]:text-gray-900"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Mobile menu toggle */}
        <button
          type="button"
          aria-label={isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={isMenuOpen}
          aria-controls="topbar-mobile-nav"
          onClick={() => setIsMenuOpen((open) => !open)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 md:hidden"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.75}
            stroke="currentColor"
            className="h-5 w-5"
            aria-hidden="true"
          >
            {isMenuOpen ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18 18 6M6 6l12 12"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5"
              />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile navigation panel */}
      {isMenuOpen && (
        <nav
          id="topbar-mobile-nav"
          aria-label="Mobile"
          className="border-t border-gray-200 md:hidden"
        >
          <ul className="mx-auto max-w-6xl px-4 py-2 sm:px-6">
            {NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href}
                  aria-current={item.href === "/" ? "page" : undefined}
                  onClick={() => setIsMenuOpen(false)}
                  className="block rounded-md px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 aria-[current=page]:text-gray-900"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  );
}
