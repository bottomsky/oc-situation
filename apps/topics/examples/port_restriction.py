"""Protocol v1 port-restriction executor. Standard library only; stdout is one JSON response."""
import hashlib
import json
import sys
from datetime import datetime


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def contains(box, point):
    west, south, east, north = box
    longitude, latitude = point["longitude"], point["latitude"]
    return south <= latitude <= north and (
        west <= longitude <= east if west <= east else longitude >= west or longitude <= east
    )


def execute(request):
    if request["protocolVersion"] != 1:
        raise ValueError("Unsupported protocol version")
    instance, dataset = request["instance"], request["dataset"]
    if instance["definitionId"] != "port-restriction":
        raise ValueError("This example supports port-restriction only")
    if dataset.get("truncated"):
        raise ValueError("Incomplete input")
    documents = {}
    for doc in dataset["intelligence"]:
        key = (doc["sourceId"], doc["externalId"])
        if key not in documents or documents[key]["version"] < doc["version"]:
            documents[key] = doc
    results = []
    for doc in documents.values():
        if doc["status"] == "withdrawn" or doc["kind"] != "port-restriction" or not doc.get("bbox"):
            continue
        groups = {}
        for point in {p["recordId"]: p for p in dataset["ais"]}.values():
            at = instant(point["occurredAt"])
            if not instant(dataset["from"]) <= at <= instant(dataset["to"]):
                continue
            if at < instant(doc["effectiveFrom"]) or (doc["effectiveTo"] and at > instant(doc["effectiveTo"])):
                continue
            if not contains(instance["config"]["bbox"], point) or not contains(doc["bbox"], point):
                continue
            if (doc["mmsis"] or doc["vesselTypes"]) and point["mmsi"] not in doc["mmsis"] and point["shipType"] not in doc["vesselTypes"]:
                continue
            groups.setdefault(point.get("vesselId", point["mmsi"]), []).append(point)
        for vessel_id, points in groups.items():
            points.sort(key=lambda p: (instant(p["occurredAt"]), p["recordId"]))
            identity = [instance["id"], instance["definitionId"], doc["sourceId"], doc["externalId"], vessel_id]
            result_id = hashlib.sha256(json.dumps(identity, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
            mmsi = points[0]["mmsi"]
            results.append({
                "id": result_id, "instanceId": instance["id"], "definitionId": instance["definitionId"],
                "definitionVersion": "1.0.0", "revision": 1, "status": "active",
                "title": "港口限制船舶识别 · " + mmsi,
                "summary": "船舶点位满足公告时间、区域和限制对象规则，需结合原文人工核验。",
                "mmsi": mmsi, **({"vesselId": points[0]["vesselId"]} if "vesselId" in points[0] else {}),
                "documentId": doc["id"], "from": points[0]["occurredAt"], "to": points[-1]["occurredAt"],
                "bbox": doc["bbox"], "confidence": "rule-match",
                "evidence": {
                    "ais": points, "documents": [doc],
                    "steps": [{"id": "python-match", "rule": "时间、边界框与限制对象逐点匹配",
                               "outcome": str(len(points)) + " 个点位命中",
                               "references": [doc["id"]] + [p["recordId"] for p in points]}],
                    "limitations": ["AIS 可能延迟或误报；边界框为近似区域，规则匹配需人工核验。"],
                    "parameters": instance["config"], "queriedAt": dataset["queriedAt"],
                }, "createdAt": dataset["queriedAt"], "updatedAt": dataset["queriedAt"],
            })
    return {"protocolVersion": 1, "results": results}


if __name__ == "__main__":
    # sort_keys deliberately demonstrates that wire property order carries no meaning.
    json.dump(execute(json.load(sys.stdin)), sys.stdout, ensure_ascii=False, sort_keys=True)
