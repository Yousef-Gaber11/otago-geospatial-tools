using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using GisApi.Models;

namespace GisApi.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class PropertiesController : ControllerBase
    {
        private readonly string _filePath = Path.Combine("..", "..", "Data", "properties_data.json");

        [HttpPost("save")]
        public IActionResult SaveProperty([FromBody] PropertyRequest payload)
        {
            if (payload == null || payload.PropertyId == 0)
            {
                return BadRequest(new { message = "بيانات العقار غير مكتملة أو فارغة." });
            }

            try
            {
                List<PropertyRequest> propertiesList = new List<PropertyRequest>();

                if (System.IO.File.Exists(_filePath))
                {
                    string existingData = System.IO.File.ReadAllText(_filePath);
                    if (!string.IsNullOrWhiteSpace(existingData))
                    {
                        propertiesList = JsonSerializer.Deserialize<List<PropertyRequest>>(existingData) ?? new List<PropertyRequest>();
                    }
                }

                propertiesList.Add(payload);

                var options = new JsonSerializerOptions { WriteIndented = true };
                string jsonString = JsonSerializer.Serialize(propertiesList, options);

                System.IO.File.WriteAllText(_filePath, jsonString);

                return Ok(new { success = true, message = "تم حفظ البيانات في ملف JSON بنجاح." });
            }
            catch (Exception ex)
            {
                return StatusCode(500, new { success = false, message = "حدث خطأ أثناء الحفظ: " + ex.Message });
            }
        }
    }
}