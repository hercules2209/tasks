/* global d3, fetch, document, window */
document.addEventListener("DOMContentLoaded", async () => {
  const svg = d3.select("#graph");
  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;

  // Controls UI (status filters + reset)
  const controls = document.createElement("div");
  controls.style.position = "absolute";
  controls.style.top = "64px";
  controls.style.right = "18px";
  controls.style.padding = "8px 10px";
  controls.style.background = "#0f131a";
  controls.style.border = "1px solid #2a2f3e";
  controls.style.borderRadius = "10px";
  controls.style.color = "#cbd5e1";
  controls.style.fontSize = "12px";
  controls.innerHTML = `
    <strong style="display:block; margin-bottom:6px;">Filters</strong>
    <label style="display:block; cursor:pointer;"><input type="checkbox" data-status="todo" checked /> todo</label>
    <label style="display:block; cursor:pointer;"><input type="checkbox" data-status="in_progress" checked /> in_progress</label>
    <label style="display:block; cursor:pointer;"><input type="checkbox" data-status="done" checked /> done</label>
    <label style="display:block; cursor:pointer;"><input type="checkbox" data-status="blocked" checked /> blocked</label>
    <button id="reset-graph" style="margin-top:8px; width:100%; background:#0f1115; color:#cbd5e1; border:1px solid #2a2f3e; border-radius:8px; padding:4px 6px; cursor:pointer;">Reset view</button>
  `;
  const host = svg.node().parentElement;
  host.style.position = "relative";
  host.appendChild(controls);

  // Arrowhead marker
  svg
    .append("defs")
    .append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 18)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", "#3a4255");

  const res = await fetch("/api/graph");
  const data = await res.json();

  const color = (s) =>
    s === "done"
      ? "#89dd13"
      : s === "in_progress"
        ? "#7aa2f7"
        : s === "blocked"
          ? "#f7768e"
          : "#9aa3b2";

  // Zoom/pan container
  const viewport = svg.append("g").attr("class", "viewport");

  svg.call(
    d3
      .zoom()
      .scaleExtent([0.3, 3])
      .on("zoom", (event) => viewport.attr("transform", event.transform)),
  );

  document.getElementById("reset-graph").addEventListener("click", () => {
    svg
      .transition()
      .duration(300)
      .call(d3.zoom().transform, d3.zoomIdentity.translate(0, 0).scale(1));
  });

  const link = viewport
    .append("g")
    .attr("stroke", "#3a4255")
    .attr("stroke-opacity", 0.9)
    .selectAll("line")
    .data(data.links)
    .join("line")
    .attr("stroke-width", 1.2)
    .attr("marker-end", "url(#arrow)");

  const nodeG = viewport
    .append("g")
    .selectAll("g.node")
    .data(data.nodes)
    .join("g")
    .attr("class", "node")
    .call(
      d3
        .drag()
        .on("start", (event, d) => {
          if (!event.active) sim.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event, d) => {
          if (!event.active) sim.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }),
    );

  nodeG
    .append("circle")
    .attr("r", 10)
    .attr("fill", (d) => color(d.status))
    .attr("stroke", "#061018")
    .attr("stroke-width", 1)
    .on("click", (_, d) => {
      window.location.href = `/tasks/${d.id}`;
    })
    .on("mouseover", function () {
      d3.select(this).transition().duration(100).attr("r", 12);
    })
    .on("mouseout", function () {
      d3.select(this).transition().duration(100).attr("r", 10);
    })
    .append("title")
    .text((d) => `#${d.id} [W${d.week}] ${d.title}`);

  nodeG
    .append("text")
    .attr("font-size", 10)
    .attr("fill", "#8a93a6")
    .attr("dx", 12)
    .attr("dy", 3)
    .text((d) => `W${d.week}:${d.id}`);

  // Force layout with mild collision
  const sim = d3
    .forceSimulation(data.nodes)
    .force(
      "link",
      d3
        .forceLink(data.links)
        .id((d) => d.id)
        .distance(80)
        .strength(0.35),
    )
    .force("charge", d3.forceManyBody().strength(-220))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius(18));

  sim.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    nodeG.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  // Status filter logic
  function applyFilters() {
    const checks = controls.querySelectorAll(
      'input[type="checkbox"][data-status]',
    );
    const allowed = new Set(
      Array.from(checks)
        .filter((c) => c.checked)
        .map((c) => c.getAttribute("data-status")),
    );
    nodeG.style("display", (d) => (allowed.has(d.status) ? null : "none"));
    link.style("display", (l) =>
      allowed.has(l.source.status) && allowed.has(l.target.status)
        ? null
        : "none",
    );
  }
  controls.addEventListener("change", applyFilters);
  applyFilters();
});
