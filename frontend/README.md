# Frontend starter

The UI has a persistent map and four workspaces. It intentionally asks the API for study metadata rather than embedding a city name, coordinates, or model settings in TypeScript.

For production:

1. replace the demo basemap style URL with a documented, licensed provider or self-hosted vector tiles;
2. serve city layers as GeoJSON only for small data, and move large grids/roads to vector tiles;
3. add a scenario-run/job API for full optimisation; and
4. map assignment results by joining `grid_id` to a grid geometry source.
