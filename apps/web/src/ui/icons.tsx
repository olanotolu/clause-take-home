/*
 * The one place icons come from. Phosphor (MIT) in its own weights: regular for inline marks, fill for status, duotone
 * where an icon stands alone. Lucide is the default of nearly every generated UI, so using it makes a product read as
 * generated; Phosphor's drawing is more distinctive and its weights let one family cover every context.
 *
 * Call sites import the names below (kept from the old set so intent reads the same) and may pass `weight` to override.
 */
import {
  ArrowCounterClockwise,
  ArrowRight as PArrowRight,
  BookBookmark,
  CalendarBlank,
  CaretDown,
  CaretRight,
  CaretUp,
  Check as PCheck,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  FilePlus,
  FileText as PFileText,
  GearSix,
  GitDiff,
  Info as PInfo,
  Kanban,
  Layout,
  ListBullets,
  ListChecks as PListChecks,
  Lock as PLock,
  MagnifyingGlass,
  MinusCircle,
  PencilSimple,
  PlusCircle as PPlusCircle,
  Play as PPlay,
  Plus as PPlus,
  Prohibit,
  Pulse,
  Question,
  Quotes,
  ShieldCheck as PShieldCheck,
  ShieldWarning,
  Sparkle,
  SquaresFour,
  Trash,
  Warning,
  X as PX,
  XCircle as PXCircle,
  type Icon,
  type IconProps,
  type IconWeight,
} from "@phosphor-icons/react";
import type { ComponentProps } from "react";

export type { IconProps, IconWeight };
type Props = ComponentProps<Icon>;

/** Wraps a Phosphor icon with a default weight; the caller's `weight` still wins. */
const make = (I: Icon, weight: IconWeight = "regular") => {
  const Wrapped = (props: Props) => <I weight={weight} {...props} />;
  return Wrapped;
};

export const Activity = make(Pulse);
export const AlertTriangle = make(Warning);
export const TriangleAlert = make(Warning, "fill");
export const ArrowRight = make(PArrowRight);
export const Ban = make(Prohibit);
export const BookOpenCheck = make(BookBookmark);
export const CalendarDays = make(CalendarBlank);
export const Check = make(PCheck, "bold");
export const CheckCircle2 = make(CheckCircle, "fill");
export const ChevronDown = make(CaretDown, "bold");
export const ChevronRight = make(CaretRight, "bold");
export const ChevronUp = make(CaretUp, "bold");
export const CircleHelp = make(Question);
export const CircleSlash = make(MinusCircle);
export const Download = make(DownloadSimple);
export const FilePlus2 = make(FilePlus);
export const FileText = make(PFileText);
export const GitCompare = make(GitDiff);
export const Info = make(PInfo);
export const LayoutDashboard = make(SquaresFour);
export const LayoutGrid = make(Kanban);
export const LayoutTemplate = make(Layout);
export const List = make(ListBullets);
export const ListChecks = make(PListChecks);
export const Loader2 = make(CircleNotch, "bold");
export const Lock = make(PLock);
export const Pencil = make(PencilSimple);
export const Play = make(PPlay, "fill");
export const Plus = make(PPlus, "bold");
export const PlusCircle = make(PPlusCircle, "fill");
export const Search = make(MagnifyingGlass);
export const Settings = make(GearSix);
export const ShieldAlert = make(ShieldWarning);
export const ShieldCheck = make(PShieldCheck);
export const Sparkles = make(Sparkle, "fill");
export const TextSelect = make(Quotes);
export const Trash2 = make(Trash);
export const Undo2 = make(ArrowCounterClockwise);
export const X = make(PX, "bold");
export const XCircle = make(PXCircle, "fill");
