"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { SpecEditor } from "@/components/spec/SpecEditor";
import { SpecPreview } from "@/components/spec/SpecPreview";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

export default function SpecPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [spec, setSpec] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.spec) setSpec(d.data.spec);
      })
      .catch(() => {});
  }, [projectId]);

  async function handleSave() {
    setSaving(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
    });
    setSaving(false);
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Specification</h2>
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
      <Tabs defaultValue="edit">
        <TabsList>
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="edit">
          <SpecEditor projectId={projectId} value={spec} onChange={setSpec} />
        </TabsContent>
        <TabsContent value="preview">
          <SpecPreview markdown={spec} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
