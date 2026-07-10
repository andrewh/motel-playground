import SwiftUI

// Node-link diagram of the topology using the engine's precomputed grid
// placement (GraphNode.col/row), the same data the web map consumes.
struct ServiceMapView: View {
    let graph: GraphData
    let serviceOrder: [String]

    var body: some View {
        if graph.nodes.isEmpty {
            EmptyResultView(message: "Validate or run a topology to see the service map.")
        } else {
            Canvas { context, size in
                let cols = max(graph.gridCols, 1)
                let rows = max(graph.gridRows, 1)
                let cellWidth = size.width / CGFloat(cols)
                let cellHeight = size.height / CGFloat(rows)
                let nodeSize = CGSize(
                    width: min(cellWidth - 24, 150),
                    height: min(cellHeight - 24, 44)
                )

                var centers: [String: CGPoint] = [:]
                for node in graph.nodes {
                    centers[node.id] = CGPoint(
                        x: (CGFloat(node.col) + 0.5) * cellWidth,
                        y: (CGFloat(node.row) + 0.5) * cellHeight
                    )
                }

                for edge in graph.edges {
                    guard let from = centers[edge.source], let to = centers[edge.target] else { continue }
                    drawEdge(context, from: from, to: to, nodeSize: nodeSize, edge: edge)
                }

                for node in graph.nodes {
                    guard let center = centers[node.id] else { continue }
                    drawNode(context, node: node, center: center, size: nodeSize)
                }
            }
            .padding(6)
        }
    }

    private func drawEdge(_ context: GraphicsContext, from: CGPoint, to: CGPoint, nodeSize: CGSize, edge: GraphEdge) {
        let start = boundaryPoint(from: from, towards: to, nodeSize: nodeSize)
        let end = boundaryPoint(from: to, towards: from, nodeSize: nodeSize)
        var line = Path()
        line.move(to: start)
        line.addLine(to: end)
        let width = 1 + 2.5 * min(max(edge.weight, 0), 1)
        var style = StrokeStyle(lineWidth: width, lineCap: .round)
        if edge.async {
            style.dash = [5, 4]
        }
        context.stroke(line, with: .color(.secondary.opacity(0.55)), style: style)

        let angle = atan2(end.y - start.y, end.x - start.x)
        var arrow = Path()
        arrow.move(to: end)
        arrow.addLine(to: CGPoint(x: end.x - 8 * cos(angle - 0.45), y: end.y - 8 * sin(angle - 0.45)))
        arrow.addLine(to: CGPoint(x: end.x - 8 * cos(angle + 0.45), y: end.y - 8 * sin(angle + 0.45)))
        arrow.closeSubpath()
        context.fill(arrow, with: .color(.secondary.opacity(0.7)))
    }

    // Where a line from a node's centre towards another point crosses the
    // node's rectangle, so edges and arrowheads stop at the box.
    private func boundaryPoint(from center: CGPoint, towards target: CGPoint, nodeSize: CGSize) -> CGPoint {
        let dx = target.x - center.x
        let dy = target.y - center.y
        guard dx != 0 || dy != 0 else { return center }
        let halfWidth = nodeSize.width / 2 + 3
        let halfHeight = nodeSize.height / 2 + 3
        var t = CGFloat.greatestFiniteMagnitude
        if dx != 0 { t = min(t, halfWidth / abs(dx)) }
        if dy != 0 { t = min(t, halfHeight / abs(dy)) }
        t = min(t, 1)
        return CGPoint(x: center.x + dx * t, y: center.y + dy * t)
    }

    private func drawNode(_ context: GraphicsContext, node: GraphNode, center: CGPoint, size: CGSize) {
        let rect = CGRect(
            x: center.x - size.width / 2,
            y: center.y - size.height / 2,
            width: size.width,
            height: size.height
        )
        let shape = Path(roundedRect: rect, cornerRadius: 8)
        let color = serviceColor(node.id, order: serviceOrder)
        context.fill(shape, with: .color(color.opacity(0.18)))
        context.stroke(shape, with: .color(color), lineWidth: node.isRoot ? 2.5 : 1.25)

        let title = Text(node.id)
            .font(.system(size: 11, weight: .semibold))
        context.draw(title, at: CGPoint(x: center.x, y: center.y - 6), anchor: .center)
        let subtitle = Text("\(node.operations.count) op\(node.operations.count == 1 ? "" : "s")")
            .font(.system(size: 9))
            .foregroundStyle(.secondary)
        context.draw(subtitle, at: CGPoint(x: center.x, y: center.y + 8), anchor: .center)
    }
}
