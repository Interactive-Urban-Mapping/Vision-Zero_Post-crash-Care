import { useEffect, useMemo, useState } from "react";
import type { LayerDefinition, GeoJsonFeature, GeoJsonCollection } from "../types";
import { attributeLabel, displayAttribute, isFireStationZero } from "../formatting";

export function AttributeTable({ layer, isOpen, onClose }: { layer: LayerDefinition | null; isOpen: boolean; onClose: () => void }) {

  const [features, setFeatures] = useState<GeoJsonFeature[]>([]);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {

    if (!isOpen || !layer) return;

    const controller = new AbortController();

    setFeatures([]);
    setStatus("loading");

    fetch(layer.url, { signal: controller.signal })

      .then((response) => {
        if (!response.ok) throw new Error("Could not load layer attributes.");
        return response.json();
      })

      .then((geojson: GeoJsonCollection) => {

        const nextFeatures = geojson.features ?? [];

        if (!controller.signal.aborted) {
          setFeatures(layer.id === "fire_stations" ? nextFeatures.filter((feature) => !isFireStationZero(feature.properties ?? {})) : nextFeatures);
          setStatus("ready");
        }

      })

      .catch(() => { if (!controller.signal.aborted) setStatus("error"); });

    return () => controller.abort();

  }, [isOpen, layer, attempt]);

  const columns = useMemo(() => {

    const names = new Set<string>();

    features.slice(0, 200).forEach((feature) => {

      Object.keys(feature.properties ?? {}).forEach((key) => names.add(key));

    });

    return Array.from(names).slice(0, 16);

  }, [features]);

  if (!isOpen || !layer) return null;

  return (

    <section className="attribute-table" aria-label="Attribute table">

      <div className="attribute-head">

        <div>

          <p className="eyebrow">Attribute table</p>

          <h2>{layer.label}</h2>

        </div>

        <button type="button" onClick={onClose}>Close</button>

      </div>

      {status === "loading" && <p className="small" role="status">Loading table records…</p>}
      {status === "error" && <div className="load-feedback" role="alert"><p>Could not load this table. Check your connection and try again.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry table</button></div>}
      {status === "ready" && features.length === 0 && <p className="small">No records are available for this layer.</p>}
      {status === "ready" && features.length > 0 && <div className="table-scroll">

        <table>

          <thead>

            <tr>

              <th>#</th>

              {columns.map((column) => <th key={column} title={column}>{attributeLabel(column)}</th>)}

            </tr>

          </thead>

          <tbody>

            {features.slice(0, 500).map((feature, index) => (

              <tr key={index}>

                <td>{index + 1}</td>

                {columns.map((column) => <td key={column} className={typeof feature.properties?.[column] === "number" ? "numeric-cell" : undefined}>{displayAttribute(feature.properties?.[column])}</td>)}

              </tr>

            ))}

          </tbody>

        </table>

      </div>

      }
      {status === "ready" && features.length > 0 && <p className="small">Showing {Math.min(features.length, 500).toLocaleString()} of {features.length.toLocaleString()} features.</p>}

    </section>

  );

}
