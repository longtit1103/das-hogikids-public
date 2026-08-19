"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { ShopeeImportModal } from "./shopee-import-modal";

/**
 * Nút mở modal import file ví Shopee — đặt cạnh card "Tiền đã về" (tab Dòng tiền).
 * `cash-flow-tab` là server component nên phần onClick tách ra client wrapper này.
 */
export function ShopeeImportButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Import file ví Shopee
      </Button>
      <ShopeeImportModal open={open} onOpenChange={setOpen} />
    </>
  );
}
