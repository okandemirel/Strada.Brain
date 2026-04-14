using UnityEngine;
namespace Game {
    /// <summary>Top-level player entity.</summary>
    public class Player : MonoBehaviour {
        public void Move(float dt) { transform.Translate(0, 0, dt); }
    }
}
