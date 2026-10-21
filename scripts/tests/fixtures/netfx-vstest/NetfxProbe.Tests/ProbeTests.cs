using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace NetfxProbe.Tests
{
    // Una prueba que pasa y otra que falla, cada una en su categoría: sin filtro la corrida es roja; con el filtro
    // «TestCategory=Unit» queda sólo la que pasa.
    [TestClass]
    public class ProbeTests
    {
        [TestMethod]
        [TestCategory("Unit")]
        public void Passes()
        {
            Assert.AreEqual(2, 1 + 1);
        }

        [TestMethod]
        [TestCategory("Broken")]
        public void Fails()
        {
            Assert.AreEqual(3, 1 + 1);
        }
    }
}
