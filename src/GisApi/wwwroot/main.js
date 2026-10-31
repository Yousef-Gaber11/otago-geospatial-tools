require([
  "esri/Map",
  "esri/views/MapView",
  "esri/layers/FeatureLayer",
  "esri/layers/GraphicsLayer",
  "esri/Graphic",
  "esri/geometry/geometryEngine",
  "esri/geometry/projection",
  "esri/geometry/Point",
  "esri/geometry/Polyline",
  "esri/geometry/SpatialReference",
  "esri/geometry/Extent",
  "esri/geometry/Polygon",
  "esri/widgets/Sketch/SketchViewModel",
], function (
  EsriMap,
  MapView,
  FeatureLayer,
  GraphicsLayer,
  Graphic,
  geometryEngine,
  projection,
  Point,
  Polyline,
  SpatialReference,
  Extent,
  Polygon,
  SketchViewModel,
) {
  //* ------------------------------------------------------------------
  //*                    Constants
  //* ------------------------------------------------------------------

  const serviceUrl =
    "https://maps.orc.govt.nz/arcgis/rest/services/PropertyExternal/MapServer";
  const NZTM = new SpatialReference({ wkid: 2193 });
  const ROAD_BUFFER_METERS = 20;

  const NOT_ROAD_WHERE = "(VNZ IS NULL OR UPPER(VNZ) <> 'ROAD')";

  //* ------------------------------------------------------------------
  //*                    Layers
  //* ------------------------------------------------------------------

  let roadsLayer = new FeatureLayer({ url: `${serviceUrl}/3` });
  let propertiesLayer = new FeatureLayer({ url: `${serviceUrl}/0` });
  let addressLayer = new FeatureLayer({ url: `${serviceUrl}/2` });

  //* ------------------------------------------------------------------
  //*                    Map & View
  //* ------------------------------------------------------------------

  const map = new EsriMap({ basemap: "topo-vector" });

  const view = new MapView({
    container: "viewDiv",
    map: map,
    center: [169.5, -45.8],
    zoom: 8,
  });

  const roadGraphics = new GraphicsLayer();
  const propertyPolygonGraphics = new GraphicsLayer();
  const intersectGraphics = new GraphicsLayer();
  const hoverGraphics = new GraphicsLayer();
  const highlightEdgeGraphics = new GraphicsLayer();
  const addressMarkerlGraphics = new GraphicsLayer();
  const edgeLabelGraphics = new GraphicsLayer();
  const distanceGraphics = new GraphicsLayer();

  map.addMany([
    roadGraphics,
    propertyPolygonGraphics,
    intersectGraphics,
    hoverGraphics,
    highlightEdgeGraphics,
    edgeLabelGraphics,
    addressMarkerlGraphics,
    distanceGraphics,
  ]);

  const projectionReady = projection
    .load()
    .then(() => console.log("تم تحميل محرك الإسقاط بنجاح"))
    .catch((error) => console.error("خطأ في تحميل محرك الإسقاط:", error));

  //* ------------------------------------------------------------------
  //*                    DOM Elements & State
  //* ------------------------------------------------------------------

  const localitySelect = document.getElementById("localitySelect");
  const roadSelect = document.getElementById("roadSelect");
  const propertySelect = document.getElementById("propertySelect");
  const addressSelect = document.getElementById("addressSelect");
  const statusEl = document.getElementById("status");
  const saveBtn = document.getElementById("saveBtn");

  let token = 0;
  let hasLocalityField = true;
  let roadsByLocality = new Map();
  let propertyAttrsById = new Map();
  let propertyGroupIds = new Map();
  let addressFeatures = [];
  let current = null;

  //* ------------------------------------------------------------------
  //*                    Helper Functions
  //* ------------------------------------------------------------------

  function setStatus(text, kind = "info") {
    statusEl.textContent = text || "";
    statusEl.className = `status ${kind}`;
  }

  function cacheGet(key, maxAgeMs = 7 * 24 * 3600 * 1000) {
    try {
      const r = JSON.parse(localStorage.getItem("gis_" + key));
      if (r && Date.now() - r.t < maxAgeMs) return r.v;
    } catch (e) {}
    return null;
  }
  function cacheSet(key, value) {
    try {
      localStorage.setItem(
        "gis_" + key,
        JSON.stringify({ t: Date.now(), v: value }),
      );
    } catch (e) {}
  }

  function resetSelect(select, text, disabled = true) {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = text;
    select.appendChild(opt);
    select.disabled = disabled;
  }

  function addOption(select, value, text) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  }

  function clearDownstreamOfRoad() {
    resetSelect(propertySelect, "-- اختر الشارع أولاً --");
    resetSelect(addressSelect, "-- اختر العقار أولاً --");
    propertyPolygonGraphics.removeAll();
    highlightEdgeGraphics.removeAll();
    addressMarkerlGraphics.removeAll();
    edgeLabelGraphics.removeAll();
    roadGraphics.removeAll();
    distanceGraphics.removeAll();
    propertyAttrsById = new Map();
    addressFeatures = [];
    current = null;
    saveBtn.disabled = true;
    renderEmptyTabs();
    view.closePopup();
  }

  function renderEmptyTabs() {
    document.getElementById("tab-edges").innerHTML =
      '<p class="placeholder-text">اختر قطعة أرض لحساب طول كل ضلع.</p>';
    document.getElementById("tab-coords").innerHTML =
      '<p class="placeholder-text">اختر قطعة أرض لعرض إحداثيات .</p>';
  }

  async function toView(geometry) {
    await projectionReady;
    try {
      return projection.project(geometry, view.spatialReference) || geometry;
    } catch (e) {
      return geometry;
    }
  }

  async function toViewMany(geometries) {
    await projectionReady;
    try {
      const out = projection.project(geometries, view.spatialReference);
      return geometries.map((g, i) => (out && out[i]) || g);
    } catch (e) {
      return geometries;
    }
  }

  function expandStreetAbbreviations(streetName) {
    if (!streetName) return "";
    let s = streetName.trim().toUpperCase();
    s = s.replace(/\bRD\b/g, "ROAD");
    s = s.replace(/\bST\b/g, "STREET");
    s = s.replace(/\bAVE\b/g, "AVENUE");
    s = s.replace(/\bDR\b/g, "DRIVE");
    s = s.replace(/\bPL\b/g, "PLACE");
    s = s.replace(/\bTCE\b/g, "TERRACE");
    s = s.replace(/\bCRES\b/g, "CRESCENT");
    s = s.replace(/\bHWY\b/g, "HIGHWAY");
    s = s.replace(/\bSHWAY\b/g, "STATE HIGHWAY");
    return s;
  }

  function extractStreetStem(streetName) {
    if (!streetName) return "";
    return streetName
      .trim()
      .replace(
        /\s+(Rd|St|Ave|Dr|Pl|Tce|Cres|Hwy|Shway|Road|Street|Avenue|Drive|Place|Terrace|Crescent|Highway)$/i,
        "",
      )
      .trim()
      .toUpperCase();
  }
  function resetDrawUI() {
    userDrawGraphics.removeAll();
    drawEdgeHighlightGraphics.removeAll();
    drawEdgeLabelGraphics.removeAll();
    intersectGraphics.removeAll();
    hoverGraphics.removeAll();
    // highlightEdgeGraphics.removeAll();
    // addressMarkerlGraphics.removeAll();
    // edgeLabelGraphics.removeAll();
    // roadGraphics.removeAll();
    drawResults.innerHTML = "";
    drawnPropertiesPayloads = [];
    if (saveDrawnPropertiesBtn) saveDrawnPropertiesBtn.style.display = "none";
    if (exportShapefileBtn) exportShapefileBtn.style.display = "none";
  }

  // ! ----------------ZOOM-------------------------------------
  async function zoomToEdge(viewLine) {
    const ext = viewLine && viewLine.extent;
    if (!ext) return;

    const pad = Math.max(Math.max(ext.width, ext.height) * 0.6, 8);
    const target = new Extent({
      xmin: ext.xmin - pad,
      ymin: ext.ymin - pad,
      xmax: ext.xmax + pad,
      ymax: ext.ymax + pad,
      spatialReference: ext.spatialReference,
    });

    try {
      await view.goTo(target, { duration: 600, easing: "ease-in-out" });
    } catch (err) {}
  }

  //* ------------------------------------------------------------------
  //*                    Feature 1: Tabs Navigation
  //* ------------------------------------------------------------------

  // switching tabs "اليحث" , "الاحداثيات" , الاضلاع
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      document
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.toggle("active", c.id === `tab-${name}`));
    });
  });

  //* ------------------------------------------------------------------
  //*               Feature 2: Localities (load + select)
  //* ------------------------------------------------------------------

  view.when(() => {
    loadLocalities();
  });

  let localityRetries = 0;
  function recreateLayers() {
    roadsLayer = new FeatureLayer({ url: `${serviceUrl}/3` });
    propertiesLayer = new FeatureLayer({ url: `${serviceUrl}/0` });
    addressLayer = new FeatureLayer({ url: `${serviceUrl}/2` });
  }

  async function loadLocalities() {
    try {
      setStatus("جاري تحميل المناطق...");

      await roadsLayer.load();
      hasLocalityField = roadsLayer.fields.some(
        (f) => f.name.toLowerCase() === "locality",
      );

      if (!hasLocalityField) {
        resetSelect(localitySelect, "لا توجد مناطق متاحة", true);
        setStatus("لا يوجد حقل للمناطق في طبقة البيانات.", "error");
        return;
      }

      let rawLocalities = cacheGet("localities_v1");

      if (!rawLocalities) {
        const q = roadsLayer.createQuery();
        q.where = "locality IS NOT NULL";
        q.groupByFieldsForStatistics = ["locality"];
        q.outStatistics = [
          {
            statisticType: "count",
            onStatisticField: "OBJECTID",
            outStatisticFieldName: "cnt",
          },
        ];
        q.returnGeometry = false;
        const res = await roadsLayer.queryFeatures(q);
        rawLocalities = res.features
          .map((f) => f.attributes.locality)
          .filter((l) => typeof l === "string" && l.trim());
        cacheSet("localities_v1", rawLocalities);
      }

      const localities = [
        ...new Set(
          // rawLocalities.map((l) => l.trim()).filter(Boolean),
          rawLocalities.map((l) => l.split("-")[0].trim()).filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b));

      resetSelect(localitySelect, "-- اختر المنطقة --", false);
      localities.forEach((loc) => addOption(localitySelect, loc, loc));
      resetSelect(roadSelect, "-- اختر المنطقة أولاً --");
      setStatus(`تم تحميل ${localities.length} منطقة.`, "ok");
    } catch (error) {
      if (localityRetries < 3) {
        localityRetries++;
        recreateLayers();
        setTimeout(loadLocalities, 5000);
        return;
      }
      resetSelect(localitySelect, "تعذر تحميل المناطق");
      setStatus("تعذر تحميل المناطق. أعد تحميل الصفحة.", "error");
    }
  }

  async function populateRoadsForLocality(loc, currentToken) {
    try {
      let names = roadsByLocality.get(loc);
      if (!names) {
        const cached = cacheGet("roads_" + loc);
        if (cached) {
          names = new Set(cached);
          roadsByLocality.set(loc, names);
        }
      }

      if (!names) {
        resetSelect(roadSelect, "-- جاري تحميل الشوارع --");
        setStatus("جاري تحميل شوارع المنطقة...");
        const q = roadsLayer.createQuery();
        const locCondition =
          !hasLocalityField || !loc ? "" : ` AND locality = '${loc.trim()}'`;
        q.where = "name IS NOT NULL" + locCondition;

        q.groupByFieldsForStatistics = ["name"];
        q.outStatistics = [
          {
            statisticType: "count",
            onStatisticField: "OBJECTID",
            outStatisticFieldName: "cnt",
          },
        ];
        q.returnGeometry = false;
        const res = await roadsLayer.queryFeatures(q);

        names = new Set(
          res.features
            .map((f) => f.attributes.name)
            .filter((n) => typeof n === "string" && n.trim()),
        );
        roadsByLocality.set(loc, names);
        cacheSet("roads_" + loc, [...names]);
      }

      if (currentToken !== token) return;

      resetSelect(roadSelect, "-- اختر الشارع --", false);
      [...names]
        .sort((a, b) => a.localeCompare(b))
        .forEach((name) => addOption(roadSelect, name, name));
      setStatus(`عدد الشوارع في المنطقة: ${names.size}`, "ok");
    } catch (error) {
      if (currentToken !== token) return;
      resetSelect(roadSelect, "تعذر تحميل الشوارع");
      setStatus("تعذر تحميل شوارع هذه المنطقة.", "error");
    }
  }

  localitySelect.addEventListener("change", async (e) => {
    const t = ++token;
    const loc = e.target.value;

    roadGraphics.removeAll();
    clearDownstreamOfRoad();
    if (!loc) {
      resetSelect(roadSelect, "-- اختر المنطقة أولاً --");
      return;
    }

    await populateRoadsForLocality(loc, t);

    if (t !== token) return;
    try {
      const qLoc = roadsLayer.createQuery();
      qLoc.where = `locality = '${loc.trim()}'`;
      qLoc.returnGeometry = true;
      qLoc.outSpatialReference = view.spatialReference;
      const resLoc = await roadsLayer.queryFeatures(qLoc);
      if (t !== token) return;

      const locGeoms = resLoc.features.map((f) => f.geometry).filter(Boolean);
      if (locGeoms.length > 0) {
        let ext = locGeoms[0].extent.clone();
        locGeoms.slice(1).forEach((g) => {
          ext = ext.union(g.extent);
        });
        view.goTo(ext.expand(1.8)).catch(() => {});
      }
    } catch (err) {
      console.error("خطأ في التكبير على المنطقة:", err);
    }
  });

  //* ------------------------------------------------------------------
  //*                Feature 3: Roads & Properties List
  //* ------------------------------------------------------------------
  async function populatePropertiesForRoad(
    roadName,
    selectedLoc,
    currentToken,
  ) {
    try {
      setStatus("جاري تحميل هندسة الشارع...");
      resetSelect(propertySelect, "-- جاري البحث عن العقارات --");

      const qRoad = roadsLayer.createQuery();
      const locCondition2 =
        !hasLocalityField || !selectedLoc
          ? ""
          : ` AND locality = '${selectedLoc.trim()}'`;
      qRoad.where =
        `UPPER(name) = '${roadName.trim().toUpperCase()}'` + locCondition2;
      qRoad.outFields = ["name"];
      qRoad.returnGeometry = true;
      qRoad.maxAllowableOffset = 2;
      qRoad.outSpatialReference = NZTM;

      const resRoad = await roadsLayer.queryFeatures(qRoad);
      const roadFeatures = resRoad.features;

      if (currentToken !== token) return;

      const roadGeoms = roadFeatures.map((f) => f.geometry).filter(Boolean);
      if (roadGeoms.length > 0) {
        const viewRoads = await toViewMany(roadGeoms);
        if (currentToken !== token) return;
        viewRoads.forEach((g) =>
          roadGraphics.add(
            new Graphic({
              geometry: g,
              symbol: {
                type: "simple-line",
                color: [41, 128, 185, 1],
                width: 4,
              },
            }),
          ),
        );
        view.goTo(viewRoads).catch(() => {});
      }

      let searchExtent = null;
      if (roadGeoms.length > 0) {
        try {
          let ext = roadGeoms[0].extent.clone();
          roadGeoms.slice(1).forEach((g) => {
            ext = ext.union(g.extent);
          });
          searchExtent = new Extent({
            xmin: ext.xmin - ROAD_BUFFER_METERS,
            ymin: ext.ymin - ROAD_BUFFER_METERS,
            xmax: ext.xmax + ROAD_BUFFER_METERS,
            ymax: ext.ymax + ROAD_BUFFER_METERS,
            spatialReference: NZTM,
          });
        } catch (err) {}
      }

      setStatus("جاري البحث عن العقارات...");
      const trimmedName = roadName.trim().toUpperCase();
      const nameVariants = new Set([trimmedName]);
      if (trimmedName.endsWith(" STREET"))
        nameVariants.add(trimmedName.replace(" STREET", " ST"));
      else if (trimmedName.endsWith(" ST"))
        nameVariants.add(trimmedName.replace(" ST", " STREET"));
      else if (trimmedName.endsWith(" ROAD"))
        nameVariants.add(trimmedName.replace(" ROAD", " RD"));
      else if (trimmedName.endsWith(" RD"))
        nameVariants.add(trimmedName.replace(" RD", " ROAD"));

      const inList = [...nameVariants].map((n) => `'${n}'`).join(",");
      const nameWhere = `UPPER(StreetName) IN (${inList}) AND ${NOT_ROAD_WHERE}`;

      await propertiesLayer.load();
      const wanted = [
        "OBJECTID",
        "PropertyID",
        "VNZ",
        "HouseNumber",
        "HouseNumberExtension",
        "StreetName",
        "LegalDescription",
        "Hectares",
      ];

      const have = new Set(
        propertiesLayer.fields.map((f) => f.name.toLowerCase()),
      );
      const base = {
        outFields: wanted.filter((f) => have.has(f.toLowerCase())),
        returnGeometry: false,
        orderByFields: ["OBJECTID ASC"],
      };

      const searchAttempts = [];
      if (searchExtent) {
        searchAttempts.push({
          ...base,
          where: nameWhere,
          geometry: searchExtent,
          spatialRelationship: "intersects",
        });
      }
      searchAttempts.push({ ...base, where: nameWhere });

      let propertyFeatures = [];
      for (const params of searchAttempts) {
        try {
          const qProp = propertiesLayer.createQuery();
          Object.assign(qProp, params);
          const resProp = await propertiesLayer.queryFeatures(qProp);
          propertyFeatures = resProp.features;
        } catch (err) {
          propertyFeatures = [];
        }
        if (currentToken !== token) return;
        if (propertyFeatures.length > 0) break;
      }

      if (propertyFeatures.length === 0) {
        resetSelect(propertySelect, "لا توجد عقارات على هذا الشارع");
        setStatus("لا توجد عقارات على هذا الشارع.", "error");
        return;
      }

      const groups = new Map();
      propertyFeatures.forEach((f) => {
        const a = f.attributes;
        const id = a.OBJECTID ?? a.PropertyID;
        const key = [
          a.PropertyID,
          a.VNZ,
          a.HouseNumber,
          a.HouseNumberExtension,
        ].join("|");
        if (!groups.has(key)) groups.set(key, { id, attrs: a, ids: [] });
        groups.get(key).ids.push(id);
      });

      const byId = new Map();
      propertyGroupIds = new Map();
      groups.forEach((g) => {
        byId.set(g.id, g.attrs);
        propertyGroupIds.set(g.id, g.ids);
      });
      propertyAttrsById = byId;

      const num = (v) =>
        v !== null && v !== undefined && isFinite(+v) ? +v : Infinity;
      const sorted = [...byId.entries()].sort(
        ([, a], [, b]) =>
          num(a.HouseNumber) - num(b.HouseNumber) ||
          String(a.HouseNumberExtension ?? "").localeCompare(
            String(b.HouseNumberExtension ?? ""),
          ),
      );

      resetSelect(propertySelect, "-- اختر العقار / قطعة الأرض --", false);
      sorted.forEach(([id, a]) => {
        const house = a.HouseNumber ?? "بدون رقم";
        const ext = a.HouseNumberExtension ? `-${a.HouseNumberExtension}` : "";
        const street = a.StreetName || roadName;
        const label = `${house}${ext} ${street} (ID: ${a.PropertyID ?? id} | VNZ: ${a.VNZ || "غير متوفر"})`;
        addOption(propertySelect, id, label);
      });
      setStatus(`تم العثور على ${sorted.length} عقار.`, "ok");
    } catch (error) {
      if (currentToken !== token) return;
      resetSelect(propertySelect, "تعذر تحميل عقارات الشارع");
      setStatus("حدث خطأ أثناء جلب العقارات.", "error");
    }
  }

  roadSelect.addEventListener("change", async (e) => {
    const roadName = e.target.value;
    const t = ++token;

    roadGraphics.removeAll();
    clearDownstreamOfRoad();
    if (!roadName) return;

    await populatePropertiesForRoad(roadName, localitySelect.value, t);
  });

  //* ------------------------------------------------------------------
  //*         Feature 4: Property Selection (geometry + popup)
  //* ------------------------------------------------------------------

  propertySelect.addEventListener("change", async (e) => {
    const id = e.target.value;
    const t = ++token;

    propertyPolygonGraphics.removeAll();
    highlightEdgeGraphics.removeAll();
    addressMarkerlGraphics.removeAll();
    edgeLabelGraphics.removeAll();
    distanceGraphics.removeAll();
    resetSelect(addressSelect, "-- جاري جلب العنوان --");
    current = null;
    view.closePopup();
    renderEmptyTabs();
    if (!id) {
      resetSelect(addressSelect, "-- اختر العقار أولاً --");
      return;
    }

    try {
      setStatus("جاري تحميل حدود العقار...");
      const q = propertiesLayer.createQuery();
      q.objectIds = propertyGroupIds.get(Number(id)) || [Number(id)];
      q.outFields = ["*"];
      q.returnGeometry = true;
      q.outSpatialReference = NZTM;
      const res = await propertiesLayer.queryFeatures(q);
      if (t !== token) return;
      if (res.features.length === 0 || !res.features[0].geometry) {
        setStatus("لا توجد هندسة لهذا العقار.", "error");
        resetSelect(addressSelect, "-- اختر العقار أولاً --");
        return;
      }

      const feature = res.features[0];
      let geom = feature.geometry;
      if (res.features.length > 1) {
        const rings = res.features.flatMap((f) =>
          f.geometry ? f.geometry.rings : [],
        );
        geom = new Polygon({ rings, spatialReference: NZTM });
      }

      const edges = calculatePolygonEdges(geom);
      const perimeter = edges.reduce((s, ed) => s + ed.length, 0);
      let area = null;
      try {
        area = geometryEngine.planarArea(geom, "square-meters");
      } catch (err) {}

      const attributes = {
        ...feature.attributes,
        PerimeterM: Number(perimeter.toFixed(2)),
        AreaSqm: area !== null ? Number(Math.abs(area).toFixed(2)) : null,
        EdgesCount: edges.length,
      };

      const viewGeom = await toView(geom);
      if (t !== token) return;

      const polygonGraphic = new Graphic({
        geometry: viewGeom,
        attributes,
        popupTemplate: createPropertyPopupTemplate(),
        symbol: {
          type: "simple-fill",
          color: [39, 174, 96, 0.4],
          outline: { color: [30, 132, 73, 1], width: 2 },
        },
      });
      propertyPolygonGraphics.add(polygonGraphic);

      current = {
        attributes,
        geometry: geom,
        viewGeometry: viewGeom,
        edges,
        perimeter,
        area,
        road: roadSelect.value,
        locality: localitySelect.value,
        address: null,
      };

      renderEdgesUI(edges, perimeter, area);
      renderCoordinatesUI(geom);
      drawDistanceToRoad(viewGeom);
      setStatus("تم تحديد العقار بنجاح.", "ok");

      saveBtn.disabled = false;

      loadAddresses(geom, t);
      drawEdgeLabels(edges, t);

      try {
        await view.goTo(viewGeom.extent.clone().expand(1.8));
      } catch (err) {}
      if (t !== token) return;
      view.openPopup({
        features: [polygonGraphic],
        location: viewGeom.centroid || viewGeom.extent.center,
      });
    } catch (error) {
      if (t !== token) return;
      setStatus("حدث خطأ أثناء تحميل العقار.", "error");
      resetSelect(addressSelect, "-- اختر العقار أولاً --");
    }
  });

  //* ------------------------------------------------------------------
  //*                    Feature 5: Address
  //* ------------------------------------------------------------------

  async function loadAddresses(geom, t) {
    try {
      const qAddr = addressLayer.createQuery();
      qAddr.outFields = ["*"];
      qAddr.returnGeometry = true;
      qAddr.outSpatialReference = NZTM;
      qAddr.geometry = geom;
      qAddr.spatialRelationship = "intersects";

      const resAddr = await addressLayer.queryFeatures(qAddr);
      let feats = resAddr.features;
      if (t !== token) return;

      if (feats.length === 0) {
        resetSelect(addressSelect, "لا يوجد عنوان مباشر", false);
        return;
      }

      addressFeatures = feats;
      resetSelect(addressSelect, "-- اختر العنوان --", false);
      const pts = await toViewMany(feats.map((f) => f.geometry));
      if (t !== token) return;

      feats.forEach((f, i) => {
        const a = f.attributes;
        const text =
          a.full_address ||
          a.full_address_number ||
          [a.address_number, a.full_road_name].filter(Boolean).join(" ") ||
          `عنوان رقم: ${a.address_id ?? "غير متوفر"}`;
        addOption(addressSelect, i, text);
        f._text = text;
        f._viewGeometry = pts[i];
      });
      drawAddressPoints(-1);
    } catch (error) {
      if (t !== token) return;
      resetSelect(addressSelect, "تعذر تحميل العناوين", false);
    }
  }

  function drawAddressPoints(selectedIndex) {
    edgeLabelGraphics.removeAll();
    addressFeatures.forEach((f, i) => {
      if (!f._viewGeometry) return;
      const selected = i === selectedIndex;
      edgeLabelGraphics.add(
        new Graphic({
          geometry: f._viewGeometry,
          symbol: {
            type: "simple-marker",
            style: "circle",
            size: selected ? 14 : 9,
            color: selected ? [230, 126, 34, 1] : [192, 57, 43, 1],
            outline: { color: [255, 255, 255, 1], width: 2 },
          },
        }),
      );
    });
  }

  addressSelect.addEventListener("change", (e) => {
    const v = e.target.value;
    const idx = v === "" ? -1 : Number(v);
    drawAddressPoints(idx);
    if (current) {
      current.address = idx >= 0 ? addressFeatures[idx]._text : null;
    }
  });

  //* ------------------------------------------------------------------
  //*                    Feature 6: Edges & Coordinates
  //* ------------------------------------------------------------------

  function calculatePolygonEdges(geometry) {
    if (!geometry) return [];
    const edges = [];
    const groups = geometry.rings || geometry.paths || [];
    groups.forEach((ring, ringIndex) => {
      for (let i = 0; i < ring.length - 1; i++) {
        const p1 = ring[i];
        const p2 = ring[i + 1];
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length > 0) {
          edges.push({ ring: ringIndex + 1, index: i + 1, length, p1, p2 });
        }
      }
    });
    return edges;
  }

  function renderEdgesUI(edges, perimeter, area) {
    const edgesTab = document.getElementById("tab-edges");
    if (edges.length === 0) {
      edgesTab.innerHTML =
        '<p class="placeholder-text">لا توجد أضلاع متاحة.</p>';
      return;
    }
    let html = '<h4 class="tab-title">أطوال أضلاع قطعة الأرض:</h4>';
    html += `<div class="summary">
      <div>عدد الأضلاع: <b>${edges.length}</b></div>
      <div>المحيط: <b>${perimeter.toFixed(2)} متر</b></div>
      ${area !== null ? `<div>المساحة: <b>${Math.abs(area).toFixed(2)} م²</b></div>` : ""}
    </div>
    <p class="hint">اضغط على ضلع لتمييزه على الخريطة.</p>
    <ul class="edge-list">`;
    edges.forEach((ed, i) => {
      html += `<li class="edge-item" data-edge="${i}">الحلقة ${ed.ring} - الضلع ${ed.index}: <b>${ed.length.toFixed(2)} متر</b></li>`;
    });
    html += "</ul>";
    edgesTab.innerHTML = html;
  }

  document.getElementById("tab-edges").addEventListener("click", (e) => {
    const li = e.target.closest(".edge-item");
    if (!li || !current) return;
    highlightEdge(Number(li.dataset.edge));
  });

  async function highlightEdge(i) {
    const ed = current && current.edges[i];
    if (!ed) return;
    const line = new Polyline({
      paths: [[ed.p1, ed.p2]],
      spatialReference: NZTM,
    });
    const viewLine = await toView(line);
    highlightEdgeGraphics.removeAll();
    highlightEdgeGraphics.add(
      new Graphic({
        geometry: viewLine,
        symbol: { type: "simple-line", color: [230, 126, 34, 1], width: 5 },
      }),
    );

    zoomToEdge(viewLine);
  }

  async function drawEdgeLabels(edges, t) {
    const shown = edges;
    if (shown.length === 0) return;

    const mids = shown.map(
      (ed) =>
        new Point({
          x: (ed.p1[0] + ed.p2[0]) / 2,
          y: (ed.p1[1] + ed.p2[1]) / 2,
          spatialReference: NZTM,
        }),
    );
    const viewMids = await toViewMany(mids);
    if (t !== token) return;

    viewMids.forEach((pt, i) => {
      addressMarkerlGraphics.add(
        new Graphic({
          geometry: pt,
          symbol: {
            type: "text",
            text: `${shown[i].length.toFixed(2)} م`,
            color: [192, 57, 43, 1],
            haloColor: [255, 255, 255, 1],
            haloSize: 2,
            font: { size: 10, weight: "bold" },
          },
        }),
      );
    });
  }

  function renderCoordinatesUI(geometry) {
    const coordsTab = document.getElementById("tab-coords");
    if (!geometry || !geometry.centroid) {
      coordsTab.innerHTML =
        '<p class="placeholder-text">لا توجد إحداثيات متاحة.</p>';
      return;
    }
    const center = geometry.centroid;
    let html = `
      <h4 class="tab-title">إحداثيات مركز العقار:</h4>
      <div class="summary" style="text-align: right; line-height: 1.8;">
        <div>إحداثي الشرق (E): <b>${center.x.toFixed(2)} م</b></div>
        <div>إحداثي الشمال (N): <b>${center.y.toFixed(2)} م</b></div>
      </div>
      <p class="hint" style="margin-top: 10px;">هذه الإحداثيات تمثل مركز أو نقطة المنتصف للقطعة (Centroid).</p>
    `;
    coordsTab.innerHTML = html;
  }

  function createPropertyPopupTemplate() {
    return {
      title: "بيانات العقار / قطعة الأرض",
      content: [
        {
          type: "fields",
          fieldInfos: [
            { fieldName: "PropertyID", label: "رقم العقار" },
            { fieldName: "VNZ", label: "رقم التقييم (VNZ)" },
            { fieldName: "HouseNumber", label: "رقم المبنى" },
            { fieldName: "StreetName", label: "اسم الشارع" },
            { fieldName: "LegalDescription", label: "الوصف القانوني" },
            {
              fieldName: "AreaSqm",
              label: "المساحة المحسوبة (م²)",
              format: { places: 2, digitSeparator: true },
            },
            {
              fieldName: "PerimeterM",
              label: "المحيط (متر)",
              format: { places: 2, digitSeparator: true },
            },
            { fieldName: "EdgesCount", label: "عدد الأضلاع" },
          ],
        },
      ],
    };
  }

  //* ------------------------------------------------------------------
  //*             Feature 7: Select Property By Map Click
  //* ------------------------------------------------------------------

  view.on("click", async (event) => {
    const mapPoint = view.toMap(event);
    if (!mapPoint) return;

    if (isDrawingMode) {
      return;
    }

    // racecondition
    const t = ++token;

    if (sketchViewModel && sketchViewModel.state === "active") {
      return;
    }

    try {
      setStatus("جاري تحديد العقار...");

      const qProp = propertiesLayer.createQuery();
      qProp.geometry = mapPoint;
      qProp.spatialRelationship = "intersects";
      qProp.where =
        typeof NOT_ROAD_WHERE !== "undefined" ? NOT_ROAD_WHERE : "1=1";
      qProp.returnGeometry = true;
      qProp.outFields = ["*"];
      qProp.outSpatialReference = view.spatialReference;

      const resProp = await propertiesLayer.queryFeatures(qProp);
      if (t !== token) return;

      if (!resProp.features || resProp.features.length === 0) {
        setStatus(
          "لا يوجد عقار في هذه النقطة، حاول الضغط داخل حدود قطعة الأرض.",
          "info",
        );
        if (localitySelect) {
          localitySelect.value = "";
          localitySelect.dispatchEvent(new Event("change"));
        }
        return;
      }

      const clickedPt = [mapPoint.x, mapPoint.y];
      const feature = resProp.features.reduce((closest, feat) => {
        if (!closest) return feat;
        const c1 = feat.geometry?.centroid;
        const c2 = closest.geometry?.centroid;
        if (!c1 || !c2) return closest;
        const dist1 = Math.hypot(c1.x - clickedPt[0], c1.y - clickedPt[1]);
        const dist2 = Math.hypot(c2.x - clickedPt[0], c2.y - clickedPt[1]);
        return dist1 < dist2 ? feat : closest;
      }, null);

      const attrs = feature.attributes;
      const targetPropertyObjId = attrs.OBJECTID ?? attrs.PropertyID;
      const targetStreetRaw = attrs.StreetName ? attrs.StreetName.trim() : null;

      if (!targetStreetRaw) {
        setStatus("العقار المحدد لا يتبع أي شارع مسجل.", "error");
        return;
      }

      const targetStem = extractStreetStem(targetStreetRaw);

      let targetLocality = null;
      let finalMatchedStreet = targetStreetRaw;

      // buffer search for locality and street match
      try {
        const qRoad = roadsLayer.createQuery();
        qRoad.geometry = feature.geometry;
        qRoad.distance = 50;
        qRoad.units = "meters";
        qRoad.spatialRelationship = "intersects";
        qRoad.where = "locality IS NOT NULL";
        qRoad.returnGeometry = false;
        qRoad.outFields = ["name", "locality"];

        const resRoad = await roadsLayer.queryFeatures(qRoad);
        if (t !== token) return;

        if (resRoad.features.length > 0) {
          const match = resRoad.features.find((f) => {
            if (!f.attributes.name) return false;
            const roadStem = extractStreetStem(f.attributes.name);
            return roadStem === targetStem;
          });

          const chosen = match || resRoad.features[0];
          if (chosen && chosen.attributes.locality) {
            targetLocality = chosen.attributes.locality.split("-")[0].trim();
          }

          if (match && match.attributes.name) {
            finalMatchedStreet = match.attributes.name;
          } else {
            finalMatchedStreet = expandStreetAbbreviations(targetStreetRaw);
          }
        }
      } catch (err) {
        console.error("خطأ في استخراج بيانات الشارع والمنطقة:", err);
      }
      if (t !== token) return;

      // المنطقة (Locality)
      if (targetLocality && localitySelect.value !== targetLocality) {
        let locOption = localitySelect.querySelector(
          `option[value="${targetLocality}"]`,
        );
        if (!locOption) {
          addOption(localitySelect, targetLocality, targetLocality);
        }
        localitySelect.value = targetLocality;
        localitySelect.disabled = false;

        await populateRoadsForLocality(targetLocality, t);
        if (t !== token) return;
      }

      // الشارع (Road)
      if (finalMatchedStreet && roadSelect.value !== finalMatchedStreet) {
        roadGraphics.removeAll();
        clearDownstreamOfRoad();

        let roadOption = roadSelect.querySelector(
          `option[value="${finalMatchedStreet}"]`,
        );
        if (!roadOption) {
          addOption(roadSelect, finalMatchedStreet, finalMatchedStreet);
        }
        roadSelect.value = finalMatchedStreet;
        roadSelect.disabled = false;

        await populatePropertiesForRoad(
          finalMatchedStreet,
          localitySelect.value,
          t,
        );
        if (t !== token) return;
      }

      // العقار (Property)
      let propOption = propertySelect.querySelector(
        `option[value="${targetPropertyObjId}"]`,
      );
      if (!propOption) {
        const opt = document.createElement("option");
        opt.value = targetPropertyObjId;
        opt.textContent = `${attrs.HouseNumber || "بدون رقم"} ${targetStreetRaw} (ID: ${targetPropertyObjId})`;
        propertySelect.appendChild(opt);
      }
      propertySelect.value = targetPropertyObjId;
      propertySelect.disabled = false;

      // propertySelect.addEventListener
      propertySelect.dispatchEvent(new Event("change"));

      setStatus("تم تحديد العقار وبناء القوائم بنجاح.", "ok");
    } catch (error) {
      console.error("خطأ في تحديد العقار بالنقر:", error);
      setStatus("حدث خطأ أثناء تحديد العقار.", "error");
    }
  });

  //* ------------------------------------------------------------------
  //*             Feature 8: Save Property (API Request)
  //* ------------------------------------------------------------------

  saveBtn.addEventListener("click", async (e) => {
    e.preventDefault();

    if (!current) return;

    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "جاري الحفظ...";
    setStatus("جاري إرسال البيانات للخادم...", "info");

    try {
      await projectionReady;
      let centroidWgs84 = null;
      let centroidNztm = null;
      if (current.geometry && current.geometry.centroid) {
        let pWgs84 =
          projection.project(current.geometry.centroid, { wkid: 4326 }) ||
          current.geometry.centroid;
        let pNztm =
          projection.project(current.geometry.centroid, NZTM) ||
          current.geometry.centroid;
        centroidWgs84 = {
          x: Number(pWgs84.x.toFixed(6)),
          y: Number(pWgs84.y.toFixed(6)),
        };
        centroidNztm = {
          x: Number(pNztm.x.toFixed(2)),
          y: Number(pNztm.y.toFixed(2)),
        };
      }

      const payload = {
        propertyId:
          current.attributes.PropertyID || current.attributes.OBJECTID,
        vnz: current.attributes.VNZ || "",
        locality: current.locality || "",
        road: current.road || "",
        houseNumber: current.attributes.HouseNumber
          ? String(current.attributes.HouseNumber)
          : "",
        legalDescription: current.attributes.LegalDescription || "",
        address: current.address || "",
        areaSqm: current.area,
        perimeterM: current.perimeter,
        edgesCount: current.edges ? current.edges.length : 0,
        centroidWgs84: centroidWgs84,
        centroidNztm: centroidNztm,
        edgesDetails: current.edges
          ? current.edges.map((edge, index) => ({
              edgeNumber: index + 1,
              lengthMeters: edge.length,
            }))
          : [],
      };

      console.log("البيانات الجاهزة للإرسال:", payload);
      const apiUrl = "/api/properties/save";

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`خطأ من الخادم: ${response.status}`);
      }

      const result = await response.json();
      console.log("رد السيرفر:", result);

      setStatus("تم حفظ بيانات العقار بنجاح في السيرفر", "ok");
    } catch (error) {
      console.error("خطأ أثناء الإرسال للـ API:", error);
      setStatus("حدث خطأ أثناء حفظ البيانات. تأكد من تشغيل السيرفر.", "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
    }
  });

  //* ------------------------------------------------------------------
  //*      Feature 9.1: Draw - Setup (layers, sketch, DOM, state)
  //* ------------------------------------------------------------------

  const userDrawGraphics = new GraphicsLayer();
  const drawEdgeHighlightGraphics = new GraphicsLayer();
  const drawEdgeLabelGraphics = new GraphicsLayer();

  map.addMany([
    userDrawGraphics,
    drawEdgeHighlightGraphics,
    drawEdgeLabelGraphics,
  ]);

  const sketchViewModel = new SketchViewModel({
    view: view,
    layer: userDrawGraphics,
    updateOnGraphicClick: false,
    polygonSymbol: {
      type: "simple-fill",
      color: [52, 152, 219, 0.4],
      outline: {
        color: [41, 128, 185, 1],
        width: 2,
      },
    },
    polylineSymbol: {
      type: "simple-line",
      color: [41, 128, 185, 1],
      width: 3,
    },
    pointSymbol: {
      type: "simple-marker",
      size: 10,
      color: [41, 128, 185, 1],
      outline: { color: [255, 255, 255, 1], width: 2 },
    },
  });

  //* ---- Draw DOM elements ----
  const drawResults = document.getElementById("drawResults");
  const saveDrawnPropertiesBtn = document.getElementById(
    "saveDrawnPropertiesBtn",
  );
  const drawMethodRadios = document.getElementsByName("drawMethod");
  const coordSysRadios = document.getElementsByName("coordSys");
  const manualInputUI = document.getElementById("manualInputUI");
  const mouseDrawUI = document.getElementById("mouseDrawUI");
  const shapefileUI = document.getElementById("shapefileUI");
  const coordSysFormGroup = document
    .querySelector('input[name="coordSys"]')
    .closest(".form-group");
  const inputX = document.getElementById("inputX");
  const inputY = document.getElementById("inputY");
  const lblX = document.getElementById("lblX");
  const lblY = document.getElementById("lblY");
  const addPointBtn = document.getElementById("addPointBtn");
  const pointsList = document.getElementById("pointsList");
  const drawManualBtn = document.getElementById("drawManualBtn");
  const clearManualBtn = document.getElementById("clearManualBtn");
  const startMouseDrawBtn = document.getElementById("startMouseDrawBtn");
  const clearMouseDrawBtn = document.getElementById("clearMouseDrawBtn");
  const clearShapefileBtn = document.getElementById("clearShapefileBtn");

  let manualPoints = [];
  let isDrawingMode = false;
  let drawnPropertiesPayloads = [];

  //* ------------------------------------------------------------------
  //*                    Feature 9.2: Draw - Method & Coord System Toggles
  //* ------------------------------------------------------------------

  // Update UI SideBar
  function updateDrawUI(method) {
    if (sketchViewModel) sketchViewModel.cancel();

    manualInputUI.style.display = "none";
    mouseDrawUI.style.display = "none";
    if (shapefileUI) shapefileUI.style.display = "none";
    if (method === "manual") {
      manualInputUI.style.display = "block";
      coordSysFormGroup.style.display = "block";
    } else if (method === "mouse") {
      mouseDrawUI.style.display = "block";
      coordSysFormGroup.style.display = "none";
    } else if (method === "shapefile") {
      if (shapefileUI) shapefileUI.style.display = "block";
      coordSysFormGroup.style.display = "none";
    }
  }

  drawMethodRadios.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      updateDrawUI(e.target.value);
    });
  });

  const initialDrawMethod = document.querySelector(
    'input[name="drawMethod"]:checked',
  ).value;
  updateDrawUI(initialDrawMethod);

  // Placeholder logic for coordinate system toggle
  coordSysRadios.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      if (e.target.value === "wgs84") {
        lblX.textContent = "Longitude (X):";
        lblY.textContent = "Latitude (Y):";
        inputX.placeholder = "مثال: 169.50";
        inputY.placeholder = "مثال: -45.80";
      } else {
        lblX.textContent = "X (Easting):";
        lblY.textContent = "Y (Northing):";
        inputX.placeholder = "مثال: 1405000";
        inputY.placeholder = "مثال: 4916000";
      }
      clearManualDraw();
    });
  });

  //* ------------------------------------------------------------------
  //*                    Feature 9.3: Draw - Manual Input
  //* ------------------------------------------------------------------
  function updateManualPointsUI() {
    pointsList.innerHTML = "";
    if (manualPoints.length === 0) {
      pointsList.innerHTML =
        "<span class='empty-msg'>لا توجد نقاط مضافة</span>";
      drawManualBtn.disabled = true;
      return;
    }

    manualPoints.forEach((pt, index) => {
      const div = document.createElement("div");
      div.className = "points-list-item";
      div.innerHTML = `<b>P${index + 1}:</b> [${pt[0]}, ${pt[1]}] 
                       <span class="points-list-item-delete" data-index="${index}">X</span>`;
      pointsList.appendChild(div);
    });

    drawManualBtn.disabled = manualPoints.length < 1;
  }

  // xPoint-btn
  pointsList.addEventListener("click", (e) => {
    if (e.target.classList.contains("points-list-item-delete")) {
      const idx = e.target.getAttribute("data-index");
      manualPoints.splice(idx, 1);
      updateManualPointsUI();
      userDrawGraphics.removeAll();
      drawResults.innerHTML = "";
    }
  });

  // addPoint-btn
  addPointBtn.addEventListener("click", () => {
    const x = parseFloat(inputX.value);
    const y = parseFloat(inputY.value);

    if (isNaN(x) || isNaN(y)) {
      setStatus("يرجى إدخال إحداثيات صحيحة.", "error");
      return;
    }
    manualPoints.push([x, y]);
    inputX.value = "";
    inputY.value = "";
    inputX.focus();
    updateManualPointsUI();
    setStatus(`تمت إضافة النقطة ${manualPoints.length}. جاهز للرسم.`, "info");
  });

  //! -----------Draw Manual Button-------------
  drawManualBtn.addEventListener("click", async () => {
    if (manualPoints.length === 0) return;

    setStatus("جاري الرسم...", "info");
    resetDrawUI();

    const isWgs84 =
      document.querySelector('input[name="coordSys"]:checked').value ===
      "wgs84";
    const sr = isWgs84 ? new SpatialReference({ wkid: 4326 }) : NZTM;

    // select type of geom
    let geometry;
    if (manualPoints.length === 1) {
      geometry = new Point({
        x: manualPoints[0][0],
        y: manualPoints[0][1],
        spatialReference: sr,
      });
    } else if (manualPoints.length === 2) {
      geometry = new Polyline({ paths: [manualPoints], spatialReference: sr });
    } else {
      const ring = [...manualPoints];
      ring.push(manualPoints[0]);
      geometry = new Polygon({ rings: [ring], spatialReference: sr });
    }

    try {
      const viewGeom = await toView(geometry);

      if (!viewGeom) {
        setStatus("الإحداثيات المدخلة خارج النطاق أو غير صحيحة.", "error");
        return;
      }

      const graphic = new Graphic({
        geometry: viewGeom,
        symbol:
          viewGeom.type === "point"
            ? {
                type: "simple-marker",
                size: 10,
                color: [41, 128, 185, 1],
                outline: { color: [255, 255, 255, 1], width: 2 },
              }
            : viewGeom.type === "polyline"
              ? { type: "simple-line", color: [41, 128, 185, 1], width: 3 }
              : sketchViewModel.polygonSymbol,
      });

      userDrawGraphics.add(graphic);

      if (viewGeom.extent) {
        view.goTo(viewGeom.extent.expand(1.8));
      } else if (viewGeom.type === "point") {
        view.goTo({ center: viewGeom, zoom: 15 });
      }

      calculateAndDisplayDrawResults(viewGeom, "الإدخال اليدوي");

      await queryAndIntersectProperties(viewGeom);
    } catch (err) {
      console.error("خطأ في رسم المضلع اليدوي:", err);
      setStatus(
        "خطأ تأكد من مطابقة الأرقام للنظام المختار (متري/درجات).",
        "error",
      );
    }
  });

  function clearManualDraw() {
    manualPoints = [];
    updateManualPointsUI();
    inputX.value = "";
    inputY.value = "";
    resetDrawUI();
  }

  clearManualBtn.addEventListener("click", () => {
    clearManualDraw();
    setStatus("تم مسح الإحداثيات اليدوية والرسومات.", "info");
  });

  //* ------------------------------------------------------------------
  //*                    Feature 9.4: Draw - Mouse Drawing
  //* ------------------------------------------------------------------
  //! --------- Draw by Mouse ---------
  // Draw-btn
  startMouseDrawBtn.addEventListener("click", () => {
    isDrawingMode = true;
    resetDrawUI();

    const selectedShape = document.getElementById("mouseDrawShape").value;
    sketchViewModel.create(selectedShape);
    if (selectedShape === "point") {
      setStatus("انقر على الخريطة لإضافة النقطة.", "info");
    } else {
      setStatus("انقر على الخريطة للرسم. اضغط مرتين للإنهاء.", "info");
    }
  });

  // res
  sketchViewModel.on("create", async (event) => {
    if (event.state === "complete") {
      isDrawingMode = false;
      const geometry = event.graphic.geometry;
      calculateAndDisplayDrawResults(geometry, "الماوس");
      await queryAndIntersectProperties(geometry);
    } else if (event.state === "cancel") {
      isDrawingMode = false;
    }
  });

  // del-btn
  clearMouseDrawBtn.addEventListener("click", () => {
    isDrawingMode = false;
    sketchViewModel.cancel();
    resetDrawUI();
    setStatus("تم مسح الرسم.", "info");
  });
  //* ------------------------------------------------------------------
  //*       Feature 9.5: Draw - Results (area, perimeter, edges)
  //* ------------------------------------------------------------------
  async function calculateAndDisplayDrawResults(geometry, source) {
    if (!geometry) return;

    let area = 0;
    let perimeter = 0;
    let edges = [];

    try {
      if (geometry.type === "polygon") {
        area = geometryEngine.planarArea(geometry, "square-meters");
      }
      edges = calculatePolygonEdges(geometry);
      perimeter = edges.reduce((sum, edge) => sum + edge.length, 0);
    } catch (err) {
      console.error("خطأ حسابي:", err);
    }

    drawEdgeHighlightGraphics.removeAll();
    drawEdgeLabelGraphics.removeAll();

    // draw edge labels on the map
    if (edges.length > 0) {
      const mids = edges.map(
        (ed) =>
          new Point({
            x: (ed.p1[0] + ed.p2[0]) / 2,
            y: (ed.p1[1] + ed.p2[1]) / 2,
            spatialReference: geometry.spatialReference,
          }),
      );
      mids.forEach((pt, i) => {
        drawEdgeLabelGraphics.add(
          new Graphic({
            geometry: pt,
            symbol: {
              type: "text",
              text: `${edges[i].length.toFixed(2)} م`,
              color: [41, 128, 185, 1],
              haloColor: [255, 255, 255, 1],
              haloSize: 2,
              font: { size: 11, weight: "bold" },
            },
          }),
        );
      });
    }

    let statsHtml = "";
    let ptWgs84 = null;
    let ptNztm = null;

    if (geometry) {
      let centerPt =
        geometry.type === "point"
          ? geometry
          : geometry.centroid || geometry.extent?.center;
      if (centerPt) {
        await projectionReady;
        ptWgs84 = projection.project(centerPt, { wkid: 4326 }) || centerPt;
        ptNztm = projection.project(centerPt, NZTM) || centerPt;
      }
    }

    if (geometry.type === "point" && ptWgs84 && ptNztm) {
      statsHtml = `
        <div class="draw-summary-row" style="flex-direction: column;">
          <span style="color:#2980b9; font-weight:bold; margin-bottom:5px;">الإحداثيات المزدوجة:</span>
          <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
            <span>درجات (WGS84):</span> <b dir="ltr">[${ptWgs84.x.toFixed(6)}, ${ptWgs84.y.toFixed(6)}]</b>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:12px;">
            <span>متري  (NZTM):</span> <b dir="ltr">[${ptNztm.x.toFixed(2)}, ${ptNztm.y.toFixed(2)}]</b>
          </div>
        </div>`;
    } else if (geometry.type === "polyline") {
      statsHtml = `<div class="draw-summary-row"><span>الطول الإجمالي:</span> <b>${perimeter.toFixed(2)} م</b></div>`;
    } else {
      statsHtml = `
        <div class="draw-summary-row"><span>المساحة:</span> <b>${Math.abs(area).toFixed(2)} م²</b></div>
        <div class="draw-summary-row"><span>المحيط:</span> <b>${perimeter.toFixed(2)} م</b></div>
      `;
    }

    // show results in the sidebar
    let html = `
      <div class="draw-summary">
        <h4>نتائج الشكل المرسوم:</h4>
        ${statsHtml}
    `;

    if (edges.length > 0) {
      html += `<div style="margin-top: 10px; border-top: 1px dashed #bce0ef; padding-top: 8px;">
                  <span style="font-weight:bold; font-size:13px; color:#2980b9;">أطوال الأضلاع (${edges.length}):</span>
                  <p class="hint" style="margin: 2px 0 5px 0;">اضغط على الضلع لتمييزه على الخريطة.</p>
                  <ul style="margin: 0; padding-right: 20px; font-size: 13px; max-height: 120px; overflow-y: auto;">`;

      edges.forEach((edge, i) => {
        html += `<li class="draw-edge-item" data-edge-idx="${i}" style="margin-bottom: 4px; cursor: pointer; padding: 2px; border-radius: 3px;">
                   الضلع ${i + 1}: <b>${edge.length.toFixed(2)} م</b>
                 </li>`;
      });
      html += `</ul></div>`;
    }

    html += `
        <div class="draw-summary-footer">
          تم الرسم باستخدام: ${source}
        </div>
      </div>
    `;

    drawResults.innerHTML = html;

    window._lastDrawnEdges = edges;
    window._lastDrawnSR = geometry.spatialReference;
  }

  // highlight edge on click
  drawResults.addEventListener("click", async (e) => {
    const li = e.target.closest(".draw-edge-item");
    if (!li || !window._lastDrawnEdges) return;

    const edgeIndex = Number(li.getAttribute("data-edge-idx"));
    const ed = window._lastDrawnEdges[edgeIndex];
    if (!ed) return;

    const line = new Polyline({
      paths: [[ed.p1, ed.p2]],
      spatialReference: window._lastDrawnSR,
    });
    const viewLine = await toView(line);

    drawEdgeHighlightGraphics.removeAll();
    drawEdgeHighlightGraphics.add(
      new Graphic({
        geometry: viewLine,
        symbol: {
          type: "simple-line",
          color: [230, 126, 34, 1],
          width: 5,
        },
      }),
    );
    zoomToEdge(viewLine);
  });

  //* ------------------------------------------------------------------
  //*           Feature 9.6: Draw - Intersect Properties
  //* ------------------------------------------------------------------
  function addressText(a) {
    return (
      a.full_address ||
      a.full_address_number ||
      [a.address_number, a.full_road_name].filter(Boolean).join(" ") ||
      ""
    );
  }

  //! Attach addresses one shoot (show all +N)
  async function attachAddresses(rows) {
    try {
      const geoms = rows.flatMap((r) => r.parts);
      if (!geoms.length) return;
      let ext = geoms[0].extent.clone();
      geoms.slice(1).forEach((g) => (ext = ext.union(g.extent)));

      const q = addressLayer.createQuery();
      q.geometry = ext;
      q.spatialRelationship = "intersects";
      q.outFields = ["*"];
      q.returnGeometry = true;
      q.outSpatialReference = view.spatialReference;
      const res = await addressLayer.queryFeatures(q);

      rows.forEach((r) => {
        const texts = [
          ...new Set(
            res.features
              .filter(
                (f) =>
                  f.geometry &&
                  r.parts.some((g) => geometryEngine.intersects(g, f.geometry)),
              )
              .map((f) => addressText(f.attributes))
              .filter(Boolean),
          ),
        ];
        if (texts.length) {
          r.address =
            texts[0] + (texts.length > 1 ? ` (+${texts.length - 1})` : "");
          r.addressAll = texts.join(" | ");
        }
      });
    } catch (err) {
      console.warn("[overlap] تعذر جلب العناوين:", err);
    }
  }

  //! ---- calc overlaps for a set of properties ----
  async function calcOverlaps(drawnViewGeom, features) {
    if (!drawnViewGeom || drawnViewGeom.type !== "polygon") return null;
    await projectionReady;

    const drawn = projection.project(drawnViewGeom, NZTM);
    if (!drawn) return null;

    const drawnSimple = geometryEngine.simplify(drawn) || drawn;

    const drawnArea = Math.abs(
      geometryEngine.planarArea(drawnSimple, "square-meters"),
    );
    if (!drawnArea) return null;

    const geoms = projection.project(
      features.map((f) => f.geometry),
      NZTM,
    );
    const byId = new Map();
    features.forEach((f, i) => {
      const g = geoms && geoms[i];
      if (!g) return;
      const id = f.attributes.PropertyID || f.attributes.OBJECTID;
      const row = byId.get(id) || {
        id,
        attrs: f.attributes,
        parts: [],
        nztm: [],
      };
      row.parts.push(f.geometry);
      row.nztm.push(g);
      byId.set(id, row);
    });

    byId.forEach((row) => {
      const merged =
        row.nztm.length > 1 ? geometryEngine.union(row.nztm) : row.nztm[0];
      const inter = merged
        ? geometryEngine.intersect(drawnSimple, merged)
        : null;
      row.overlap = inter
        ? Math.abs(geometryEngine.planarArea(inter, "square-meters"))
        : 0;
      row.area = merged
        ? Math.abs(geometryEngine.planarArea(merged, "square-meters"))
        : 0;
    });

    const rows = [...byId.values()]
      .filter((r) => r.overlap > 0.01)
      .map((r) => ({
        ...r,
        pctDrawn: (r.overlap / drawnArea) * 100, // from drawn area
        pctProp: (r.overlap / r.area) * 100, // from property area
      }))
      .sort((a, b) => b.overlap - a.overlap);

    await attachAddresses(rows);

    const outside = Math.max(0, 100 - rows.reduce((s, r) => s + r.pctDrawn, 0));
    return { rows, outside };
  }

  const overlapRows = new Map();

  // show overlaps in the sidebar
  function renderOverlaps(res) {
    if (!res || res.rows.length === 0 || !intersectGraphics.graphics.length)
      return;

    const label = (a) =>
      [a.HouseNumber, a.HouseNumberExtension, a.StreetName]
        .filter(Boolean)
        .join(" ") || `ID ${a.PropertyID ?? a.OBJECTID}`;

    overlapRows.clear();
    let html = `<div class="draw-summary" style="margin-top: 8px;">
      <h4 style="margin: 0 0 8px;">نسبة التداخل مع العقارات:</h4>
      <ul style="list-style: none; margin: 0; padding: 0;">`;

    res.rows.forEach((r) => {
      overlapRows.set(String(r.id), r);
      html += `
        <li class="overlap-item" data-oid="${r.id}"
            style="padding: 8px 10px; margin-bottom: 6px; background: #fff; border: 1px solid #cfe0ea; border-radius: 6px; cursor: pointer; transition: background .15s;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <bdi style="font-weight: bold; font-size: 13px;" title="${(r.addressAll || "").replace(/"/g, "&quot;")}">${r.address || label(r.attrs)}</bdi>
            <bdi style="background: #2980b9; color: #fff; border-radius: 10px; padding: 1px 9px; font-size: 12px; font-weight: bold;">${r.pctDrawn.toFixed(1)}%</bdi>
          </div>
          <div style="height: 5px; background: #e3edf3; border-radius: 3px; margin: 7px 0;">
            <div style="width: ${Math.min(r.pctDrawn, 100)}%; height: 100%; background: #2980b9; border-radius: 3px;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 12px; color: #5d6d7e;">
            <span>المساحة المشتركة: <bdi>${r.overlap.toFixed(1)} م²</bdi></span>
            <span>من العقار: <bdi>${r.pctProp.toFixed(1)}%</bdi></span>
          </div>
        </li>`;
    });
    html += `</ul>`;
    if (res.outside > 0.5) {
      html += `<div style="display: flex; justify-content: space-between; padding: 6px 10px; background: #eef2f5; border-radius: 6px; font-size: 13px;">
        <span>خارج أي عقار</span><bdi style="font-weight: bold;">${res.outside.toFixed(1)}%</bdi>
      </div>`;
    }
    html += `</div>`;
    drawResults.insertAdjacentHTML("beforeend", html);
  }

  //! highlight for property parts in map and highlight in sidebar
  drawResults.addEventListener("mouseover", (e) => {
    const li = e.target.closest(".overlap-item");
    if (!li || li.contains(e.relatedTarget)) return;
    const row = overlapRows.get(li.dataset.oid);
    if (!row) return;
    li.style.background = "#fdf2e9";
    hoverGraphics.removeAll();
    row.parts.forEach((g) =>
      hoverGraphics.add(
        new Graphic({
          geometry: g,
          symbol: {
            type: "simple-fill",
            color: [211, 84, 0, 0.55],
            outline: { color: [135, 54, 0, 1], width: 4 },
          },
        }),
      ),
    );
  });

  //! remove highlight when mouse leaves the row
  drawResults.addEventListener("mouseout", (e) => {
    const li = e.target.closest(".overlap-item");
    if (!li || li.contains(e.relatedTarget)) return;
    li.style.background = "#fff";
    hoverGraphics.removeAll();
  });

  //! zoom to the property when clicked
  drawResults.addEventListener("click", (e) => {
    const li = e.target.closest(".overlap-item");
    const row = li && overlapRows.get(li.dataset.oid);
    if (!row) return;
    const ext = row.parts.reduce(
      (acc, g) => (acc ? acc.union(g.extent) : g.extent.clone()),
      null,
    );
    if (ext) view.goTo(ext.expand(1.5)).catch(() => {});
  });

  //! query and intersect properties
  async function queryAndIntersectProperties(geometry) {
    setStatus("جاري البحث عن المباني المتقاطعة...", "info");
    saveDrawnPropertiesBtn.style.display = "none";

    try {
      const qProp = propertiesLayer.createQuery();
      qProp.geometry = geometry;
      qProp.spatialRelationship = "intersects";
      qProp.where =
        typeof NOT_ROAD_WHERE !== "undefined" ? NOT_ROAD_WHERE : "1=1";
      qProp.returnGeometry = true;
      qProp.outFields = ["*"];
      qProp.outSpatialReference = view.spatialReference;

      const resProp = await propertiesLayer.queryFeatures(qProp);

      if (!resProp.features || resProp.features.length === 0) {
        setStatus("تم الرسم، ولا توجد عقارات تتقاطع مع هذا الشكل.", "info");
        drawnPropertiesPayloads = [];
        return;
      }

      const uniqueFeaturesMap = new Map();
      resProp.features.forEach((feat) => {
        const id = feat.attributes.PropertyID || feat.attributes.OBJECTID;
        if (!uniqueFeaturesMap.has(id)) {
          uniqueFeaturesMap.set(id, feat);
        }
      });
      const matchedFeatures = Array.from(uniqueFeaturesMap.values());

      setStatus(
        `تم العثور على ${matchedFeatures.length} عقار متقاطع فريد.`,
        "ok",
      );

      const highlightSymbol = {
        type: "simple-fill",
        color: [230, 126, 34, 0.4],
        outline: { color: [211, 84, 0, 1], width: 2 },
      };

      const graphicsToDraw = matchedFeatures.map(
        (feat) =>
          new Graphic({
            geometry: feat.geometry,
            attributes: feat.attributes,
            symbol: highlightSymbol,
          }),
      );

      intersectGraphics.removeAll();
      intersectGraphics.addMany(graphicsToDraw);

      calcOverlaps(geometry, resProp.features)
        .then(renderOverlaps)
        .catch((err) => console.error("[overlap]", err));

      drawnPropertiesPayloads = await Promise.all(
        matchedFeatures.map(async (feat) => {
          const attrs = feat.attributes;
          const geom = feat.geometry;

          let area = 0;
          let perimeter = 0;
          let edges = [];

          if (geom) {
            area = Math.abs(geometryEngine.planarArea(geom, "square-meters"));
            edges = calculatePolygonEdges(geom);
            perimeter = edges.reduce((sum, edge) => sum + edge.length, 0);
          }
          const isWgs84 =
            document.querySelector('input[name="coordSys"]:checked')?.value ===
            "wgs84";

          let centroidWgs84 = null;
          let centroidNztm = null;
          if (geom && (geom.centroid || geom.extent?.center)) {
            let centerPt = geom.centroid || geom.extent.center;
            await projectionReady;
            let pWgs84 =
              projection.project(centerPt, { wkid: 4326 }) || centerPt;
            let pNztm = projection.project(centerPt, NZTM) || centerPt;

            centroidWgs84 = {
              x: Number(pWgs84.x.toFixed(6)),
              y: Number(pWgs84.y.toFixed(6)),
            };
            centroidNztm = {
              x: Number(pNztm.x.toFixed(2)),
              y: Number(pNztm.y.toFixed(2)),
            };
          }

          return {
            propertyId: attrs.PropertyID || attrs.OBJECTID,
            vnz: attrs.VNZ || "",
            locality: localitySelect.value || "",
            road: attrs.StreetName || "",
            houseNumber: attrs.HouseNumber ? String(attrs.HouseNumber) : "",
            legalDescription: attrs.LegalDescription || "",
            address: "",
            areaSqm: Number(area.toFixed(2)),
            perimeterM: Number(perimeter.toFixed(2)),
            edgesCount: edges.length,
            centroidWgs84: centroidWgs84,
            centroidNztm: centroidNztm,
            edgesDetails: edges.map((e, idx) => ({
              edgeNumber: idx + 1,
              lengthMeters: Number(e.length.toFixed(2)),
            })),
          };
        }),
      );

      //HTML
      saveDrawnPropertiesBtn.textContent = `حفظ العقارات المتقاطعة (${drawnPropertiesPayloads.length})`;
      saveDrawnPropertiesBtn.style.display = "block";
      saveDrawnPropertiesBtn.disabled = false;
      if (exportShapefileBtn) exportShapefileBtn.style.display = "block";
    } catch (err) {
      console.error("خطأ في الاستعلام المكانى:", err);
      setStatus("حدث خطأ أثناء جلب العقارات المتقاطعة.", "error");
    }
  }

  //* ------------------------------------------------------------------
  //*        Feature 9.7: Draw - Save Intersected Properties
  //* ------------------------------------------------------------------
  saveDrawnPropertiesBtn.addEventListener("click", async (e) => {
    e.preventDefault();

    if (drawnPropertiesPayloads.length === 0) return;

    const originalText = saveDrawnPropertiesBtn.textContent;
    saveDrawnPropertiesBtn.disabled = true;
    saveDrawnPropertiesBtn.textContent = "جاري الحفظ...";
    setStatus(
      `جاري إرسال ${drawnPropertiesPayloads.length} عقار للخادم...`,
      "info",
    );

    try {
      const apiUrl = "/api/properties/save";
      let successCount = 0;

      for (const payload of drawnPropertiesPayloads) {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          successCount++;
        } else {
          console.error(
            `خطأ في حفظ العقار ${payload.propertyId}:`,
            response.status,
          );
        }
      }

      if (successCount === drawnPropertiesPayloads.length) {
        setStatus(
          `تم حفظ جميع العقارات المتقاطعة (${successCount}) بنجاح`,
          "ok",
        );
        saveDrawnPropertiesBtn.textContent = "تم الحفظ بنجاح";
      } else {
        setStatus(
          `تم حفظ ${successCount} فقط من أصل ${drawnPropertiesPayloads.length}.`,
          "error",
        );
        saveDrawnPropertiesBtn.disabled = false;
        saveDrawnPropertiesBtn.textContent = originalText;
      }
    } catch (error) {
      console.error("خطأ أثناء الإرسال للـ API:", error);
      setStatus("حدث خطأ أثناء حفظ البيانات. تأكد من تشغيل السيرفر.", "error");
      saveDrawnPropertiesBtn.disabled = false;
      saveDrawnPropertiesBtn.textContent = originalText;
    }
  });

  //* ------------------------------------------------------------------
  //*        Feature 10: Draw - Distance to Road
  //* ------------------------------------------------------------------
  async function drawDistanceToRoad(propertyGeom) {
    if (!propertyGeom || roadGraphics.graphics.length === 0) return;

    //! --- Draw Distance to Road ---
    const roadGeoms = roadGraphics.graphics.toArray().map((g) => g.geometry);
    const unifiedRoad = geometryEngine.union(roadGeoms);

    const propBoundary = new Polyline({
      paths: propertyGeom.rings,
      spatialReference: propertyGeom.spatialReference,
    });

    let minPtProp = null;
    let minPtRoad = null;
    let minDistance = Infinity;

    propertyGeom.rings.forEach((ring) => {
      ring.forEach((coords) => {
        const pt = new Point({
          x: coords[0],
          y: coords[1],
          spatialReference: propertyGeom.spatialReference,
        });
        const nearestOnRoad = geometryEngine.nearestCoordinate(unifiedRoad, pt);
        if (nearestOnRoad) {
          const d = geometryEngine.distance(
            pt,
            nearestOnRoad.coordinate,
            "meters",
          );
          if (d < minDistance) {
            minDistance = d;
            minPtProp = pt;
            minPtRoad = nearestOnRoad.coordinate;
          }
        }
      });
    });

    unifiedRoad.paths.forEach((path) => {
      path.forEach((coords) => {
        const pt = new Point({
          x: coords[0],
          y: coords[1],
          spatialReference: propertyGeom.spatialReference,
        });
        const nearestOnProp = geometryEngine.nearestCoordinate(
          propBoundary,
          pt,
        );
        if (nearestOnProp) {
          const d = geometryEngine.distance(
            pt,
            nearestOnProp.coordinate,
            "meters",
          );
          if (d < minDistance) {
            minDistance = d;
            minPtRoad = pt;
            minPtProp = nearestOnProp.coordinate;
          }
        }
      });
    });

    if (minPtProp && minPtRoad && minDistance >= 0.1) {
      const line = new Polyline({
        paths: [
          [
            [minPtProp.x, minPtProp.y],
            [minPtRoad.x, minPtRoad.y],
          ],
        ],
        spatialReference: propertyGeom.spatialReference,
      });

      const midPoint = new Point({
        x: (minPtProp.x + minPtRoad.x) / 2,
        y: (minPtProp.y + minPtRoad.y) / 2,
        spatialReference: propertyGeom.spatialReference,
      });

      distanceGraphics.add(
        new Graphic({
          geometry: line,
          symbol: {
            type: "simple-line",
            color: [52, 73, 94, 0.8],
            width: 2.5,
            style: "short-dash",
          },
        }),
      );

      distanceGraphics.add(
        new Graphic({
          geometry: midPoint,
          symbol: {
            type: "text",
            text: `${minDistance.toFixed(2)} م`,
            color: [231, 76, 60, 1],
            haloColor: [255, 255, 255, 0.9],
            haloSize: "2px",
            font: { size: 12, weight: "bold", family: "sans-serif" },
            yoffset: 8,
          },
        }),
      );
    }

    //! ---  buffer search for alternative roads ---
    try {
      const qRoad = roadsLayer.createQuery();
      qRoad.geometry = propertyGeom;
      qRoad.distance = 80;
      qRoad.units = "meters";
      qRoad.spatialRelationship = "intersects";
      qRoad.returnGeometry = true;
      qRoad.outSpatialReference = propertyGeom.spatialReference;

      const resRoad = await roadsLayer.queryFeatures(qRoad);
      if (!resRoad.features || resRoad.features.length === 0) return;

      let altMinDist = Infinity;
      let altPtProp = null;
      let altPtRoad = null;

      resRoad.features.forEach((roadFeat) => {
        const roadGeom = roadFeat.geometry;
        if (!roadGeom) return;

        propertyGeom.rings.forEach((ring) => {
          ring.forEach((coords) => {
            const pt = new Point({
              x: coords[0],
              y: coords[1],
              spatialReference: propertyGeom.spatialReference,
            });
            const nearestOnRoad = geometryEngine.nearestCoordinate(
              roadGeom,
              pt,
            );
            if (nearestOnRoad) {
              const d = geometryEngine.distance(
                pt,
                nearestOnRoad.coordinate,
                "meters",
              );
              if (d < altMinDist) {
                altMinDist = d;
                altPtProp = pt;
                altPtRoad = nearestOnRoad.coordinate;
              }
            }
          });
        });
      });

      if (
        altPtProp &&
        altPtRoad &&
        altMinDist < minDistance - 0.1 &&
        altMinDist >= 0.1
      ) {
        const altLine = new Polyline({
          paths: [
            [
              [altPtProp.x, altPtProp.y],
              [altPtRoad.x, altPtRoad.y],
            ],
          ],
          spatialReference: propertyGeom.spatialReference,
        });

        const altMidPoint = new Point({
          x: (altPtProp.x + altPtRoad.x) / 2,
          y: (altPtProp.y + altPtRoad.y) / 2,
          spatialReference: propertyGeom.spatialReference,
        });

        distanceGraphics.add(
          new Graphic({
            geometry: altLine,
            symbol: {
              type: "simple-line",
              color: [142, 68, 173, 0.9],
              width: 3,
              style: "solid",
            },
          }),
        );

        distanceGraphics.add(
          new Graphic({
            geometry: altMidPoint,
            symbol: {
              type: "text",
              text: `طريق أقرب: ${altMinDist.toFixed(2)} م`,
              color: [142, 68, 173, 1],
              haloColor: [255, 255, 255, 0.9],
              haloSize: "2px",
              font: { size: 11, weight: "bold", family: "sans-serif" },
              yoffset: 8,
            },
          }),
        );
      }
    } catch (err) {
      console.error("خطأ في استعلام الشوارع المحيطة الإضافية:", err);
    }
  }

  //* ------------------------------------------------------------------
  //*        Feature 11.1: Download Drawn Shapes as Shapefile
  //* ------------------------------------------------------------------
  const exportShapefileBtn = document.getElementById("exportShapefileBtn");
  if (exportShapefileBtn) {
    exportShapefileBtn.addEventListener("click", async () => {
      const graphics = userDrawGraphics.graphics.toArray();
      if (graphics.length === 0) {
        setStatus("لا يوجد رسم لتصديره.", "error");
        return;
      }

      setStatus("جاري بناء وتجهيز ملف Shapefile...", "info");

      try {
        await projectionReady;
        const features = [];
        let primaryGeomType = "Shape";

        for (let i = 0; i < graphics.length; i++) {
          const g = graphics[i];
          if (!g.geometry) continue;

          const wgs84Geom =
            projection.project(g.geometry, { wkid: 4326 }) || g.geometry;

          let coordinates = [];
          let type = "";

          if (wgs84Geom.type === "point") {
            type = "Point";
            primaryGeomType = "Point";
            coordinates = [wgs84Geom.x, wgs84Geom.y];
          } else if (wgs84Geom.type === "polyline") {
            type = "MultiLineString";
            primaryGeomType = "Line";
            coordinates = wgs84Geom.paths;
          } else if (wgs84Geom.type === "polygon") {
            type = "Polygon";
            primaryGeomType = "Polygon";
            coordinates = wgs84Geom.rings;
          }

          if (type) {
            features.push({
              type: "Feature",
              properties: {
                Id: i + 1,
                Source: "Otago GIS Tool",
                GeomType: type,
              },
              geometry: { type, coordinates },
            });
          }
        }

        if (features.length === 0) {
          setStatus("لم يتم العثور على أشكال قابلة للتصدير.", "error");
          return;
        }

        const currentMethodRadio = document.querySelector(
          'input[name="drawMethod"]:checked',
        );
        let methodText = "Unknown";
        if (currentMethodRadio) {
          const val = currentMethodRadio.value;
          if (val === "manual") methodText = "Manual";
          else if (val === "mouse") methodText = "Mouse";
          else if (val === "shapefile") methodText = "ImportedFile";
        }

        const dynamicFileName = `Drawing_${methodText}_${primaryGeomType}.zip`;

        const geojson = { type: "FeatureCollection", features };
        const options = {
          folder: "My_Drawing",
          types: { point: "Points", polygon: "Polygons", line: "Lines" },
        };

        let content = shpwrite.zip(geojson, options);
        if (content instanceof Promise) {
          content = await content;
        }

        const byteCharacters = atob(content);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: "application/zip" });

        if (window.showSaveFilePicker) {
          try {
            const fileHandle = await window.showSaveFilePicker({
              suggestedName: dynamicFileName,
              types: [
                {
                  description: "ZIP Archive",
                  accept: { "application/zip": [".zip"] },
                },
              ],
            });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();

            setStatus(`تم حفظ الملف باسم (${dynamicFileName}) بنجاح.`, "ok");
          } catch (err) {
            if (err.name === "AbortError") {
              setStatus("تم إلغاء الحفظ.", "info");
            } else {
              console.error(err);
              setStatus("حدث خطأ أثناء تحديد مسار الحفظ.", "error");
            }
          }
        } else {
          const url = window.URL.createObjectURL(blob);
          const downloadLink = document.createElement("a");
          downloadLink.href = url;
          downloadLink.download = dynamicFileName;
          document.body.appendChild(downloadLink);
          downloadLink.click();
          document.body.removeChild(downloadLink);
          window.URL.revokeObjectURL(url);
          setStatus(`تم تحميل الملف باسم (${dynamicFileName}) بنجاح.`, "ok");
        }
      } catch (err) {
        console.error("Shapefile Export Error:", err);
        setStatus("حدث خطأ داخلي أثناء بناء الملف.", "error");
      }
    });
  }
  //* ------------------------------------------------------------------
  //*        Feature 11.2: Upload and Parse Shapefile
  //* ------------------------------------------------------------------

  const shpFileInput = document.getElementById("shpFileInput");

  if (shpFileInput) {
    shpFileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      setStatus("جاري قراءة الملف وتحليله...", "info");
      resetDrawUI();

      try {
        const buffer = await file.arrayBuffer();

        const geojson = await shp(buffer);

        let features = Array.isArray(geojson)
          ? geojson.flatMap((fc) => fc.features)
          : geojson.features;

        if (!features || features.length === 0) {
          setStatus("الملف لا يحتوي على أي أشكال هندسية.", "error");
          return;
        }

        const wgs84 = new SpatialReference({ wkid: 4326 });
        const esriGeometries = [];
        features.forEach((f) => {
          const geom = f.geometry;
          if (!geom) return;
          let esriGeom = null;

          if (geom.type === "Point") {
            esriGeom = new Point({
              x: geom.coordinates[0],
              y: geom.coordinates[1],
              spatialReference: wgs84,
            });
          } else if (geom.type === "LineString") {
            esriGeom = new Polyline({
              paths: [geom.coordinates],
              spatialReference: wgs84,
            });
          } else if (geom.type === "MultiLineString") {
            esriGeom = new Polyline({
              paths: geom.coordinates,
              spatialReference: wgs84,
            });
          } else if (geom.type === "Polygon") {
            esriGeom = new Polygon({
              rings: geom.coordinates,
              spatialReference: wgs84,
            });
          } else if (geom.type === "MultiPolygon") {
            let rings = [];
            geom.coordinates.forEach(
              (polyCoords) => (rings = rings.concat(polyCoords)),
            );
            esriGeom = new Polygon({ rings: rings, spatialReference: wgs84 });
          }

          if (esriGeom) {
            esriGeometries.push({
              geometry: esriGeom,
              attributes: f.properties || {},
            });
          }
        });

        if (esriGeometries.length === 0) {
          setStatus("لم يتم التعرف على أشكال هندسية مدعومة في الملف.", "error");
          return;
        }

        // projection 84 -> ntzm
        const viewGeometries = await toViewMany(
          esriGeometries.map((item) => item.geometry),
        );

        const geometriesToUnion = [];
        viewGeometries.forEach((viewGeom, idx) => {
          let symbol =
            viewGeom.type === "point"
              ? sketchViewModel.pointSymbol
              : viewGeom.type === "polyline"
                ? sketchViewModel.polylineSymbol
                : sketchViewModel.polygonSymbol;

          const graphic = new Graphic({
            geometry: viewGeom,
            symbol: symbol,
            attributes: esriGeometries[idx].attributes,
          });

          userDrawGraphics.add(graphic);
          geometriesToUnion.push(viewGeom);
        });

        // one geom (many polygons)
        let finalGeometry;
        try {
          finalGeometry =
            geometriesToUnion.length > 1
              ? geometryEngine.union(geometriesToUnion)
              : geometriesToUnion[0];
        } catch (e) {
          finalGeometry = geometriesToUnion[0];
        }

        if (finalGeometry && finalGeometry.type === "point") {
          view
            .goTo({ target: finalGeometry, zoom: 16 }, { duration: 600 })
            .catch(() => {});
        } else {
          view.goTo(userDrawGraphics.graphics.toArray()).catch(() => {});
        }

        setStatus(
          `تم رسم ${esriGeometries.length} شكل من الملف. جاري حساب التقاطعات...`,
          "ok",
        );

        calculateAndDisplayDrawResults(finalGeometry, "رفع ملف Shapefile");
        await queryAndIntersectProperties(finalGeometry);
      } catch (err) {
        console.error("خطأ في قراءة ملف الشيب فايل:", err);
        setStatus(
          "حدث خطأ أثناء القراءة. تأكد أنه ملف .zip صالح يحتوي على مكونات Shapefile.",
          "error",
        );
      }

      shpFileInput.value = "";
    });
  }
  if (clearShapefileBtn) {
    clearShapefileBtn.addEventListener("click", () => {
      if (shpFileInput) shpFileInput.value = "";
      resetDrawUI();
      setStatus("تم مسح الرسومات المستخرجة من الملف.", "info");
    });
  }
});