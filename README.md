# MetroMate — Delhi Metro Route Planner

Plan a Delhi Metro journey between any two of 257 stations and get the **fastest**, **shortest**, **fewest-change** or **fewest-stop** route, with travel time, DMRC fare and step-by-step directions. The map shows how the search algorithm explores the network before it draws the route.

Mini project for **Design and Analysis of Algorithms**.

## Algorithms
| Feature | Algorithm | Complexity |
|---|---|---|
| Fastest / shortest route | Dijkstra with a binary-heap priority queue (greedy) | O((V + E) log V) |
| Goal-directed search | A* with a haversine (straight-line) heuristic | O((V + E) log V) |
| Fewest changes | Dijkstra with lexicographic weights (change = 1000) | O((V + E) log V) |
| Fewest stops | 0-1 BFS with a deque | O(V + E) |
| Travel-time map | single-source Dijkstra to every station | O((V + E) log V) |

The network is modelled as one node per (station, line). Riding to the next station is a weighted edge, changing line inside a station is a transfer edge, and walkway interchanges (e.g. Dhaula Kuan ↔ Durgabai Deshmukh South Campus) are walk edges.

## Data
Station names, lines, distances and coordinates come from the Kaggle *Delhi Metro Dataset* (`data/delhi_metro_raw.csv`). `tools/build_data.py` cleans names (so interchanges match), fixes a few wrong coordinates and writes `js/metro-data.js`. The dataset may not include the newest extensions. Travel times are estimates (≈32 km/h average, 30 s per stop, 5 min per change). Fares use the DMRC distance slabs revised on 25 Aug 2025.

## Run locally
```bash
python3 -m http.server 8000
```
No build step and no libraries — plain HTML, CSS and JavaScript.
