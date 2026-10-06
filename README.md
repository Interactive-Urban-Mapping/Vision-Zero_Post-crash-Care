# Vision Zero Post-crash Care Webmap

An interactive MapLibre webmap for examining post-crash emergency-response conditions and comparing historical, proactive, and user-defined station-allocation scenarios in Toronto.

## Open the webmap

[Launch the Vision Zero Post-crash Care webmap](https://interactive-urban-mapping.github.io/Vision-Zero_Post-crash-Care/)

The website is deployed automatically from the `main` branch through GitHub Pages.

## Main app source

`frontend` is the maintained source for both local use and deployment. The Desktop frontend path points to this same folder.

## Run locally

Requirements: Node.js 20 or newer and npm.

```powershell
cd frontend
npm ci
npm run dev
```

Open the local address printed by Vite. The browser-ready layers are included under `frontend/public/layers`, so no data-preparation step is required.

## Public repository scope

This repository is intentionally limited to the material required to build, understand, and display the public webmap:

- React, Vite, MapLibre, and browser-based optimization source code
- Browser-ready GeoJSON, raster, analysis, and manual-allocation inputs
- Data-source, licensing, and study documentation
- The retained `data/Original Data` source reference

Large intermediate OD matrices, duplicated shapefiles, analytical working directories, Python preparation utilities, backend prototypes, and model-development outputs are not included. Those materials are not required to operate the webmap and should be archived separately with the research reproducibility package.

## Build for deployment

```powershell
cd frontend
npm ci
npm run build
```

The production website is generated in `frontend/dist`. The GitHub Actions workflow publishes only that directory, keeping the deployed site well below GitHub Pages' 1 GB site limit.

## Data attribution

Contains information licensed under the [Open Government Licence - Toronto](https://open.toronto.ca/open-data-licence/).

- [City of Toronto Open Data Portal](https://open.toronto.ca/)
- [City of Toronto Vision Zero](https://www.toronto.ca/services-payments/streets-parking-transportation/road-safety/vision-zero/safety-measures-and-mapping/)

The source data were cleaned, aggregated, transformed, and used to produce derived analytical layers and model outputs. The City of Toronto does not endorse this project or its results. See `DATA_LICENSE.md` for the full data notice.

## Licence

The project software is available under the [MIT License](LICENSE). Data and third-party materials remain subject to the terms described in `DATA_LICENSE.md`.

