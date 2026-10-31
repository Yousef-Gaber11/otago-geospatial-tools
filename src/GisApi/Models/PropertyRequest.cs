namespace GisApi.Models
{
    public class EdgeData
    {
        public int EdgeNumber { get; set; }
        public double LengthMeters { get; set; }
    }

    public class PointCoord
    {
        public double X { get; set; }
        public double Y { get; set; }
    }

    public class PropertyRequest
    {
        public int PropertyId { get; set; }
        public string? Vnz { get; set; }
        public string? Locality { get; set; }
        public string? Road { get; set; }
        public string? HouseNumber { get; set; }
        public string? LegalDescription { get; set; }
        public string? Address { get; set; }
        public double AreaSqm { get; set; }
        public double PerimeterM { get; set; }
        public int EdgesCount { get; set; }

        public PointCoord? CentroidWgs84 { get; set; }
        public PointCoord? CentroidNztm { get; set; }

        public List<EdgeData>? EdgesDetails { get; set; }
    }
}